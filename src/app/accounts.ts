/**
 * Multi-account support. Kiro keeps a single active login on disk
 * (`~/.aws/sso/cache/kiro-auth-token.json`); this manager lets the bot keep
 * several logins side by side and switch between them:
 *
 *   • capture — snapshot the currently active token as a named account,
 *   • switch  — copy a saved snapshot back over the live token (agent restart
 *               is done by the caller), then Kiro is logged in as that account,
 *   • forget  — drop a saved snapshot.
 *
 * Snapshots are token files copied under `<dataDir>/accounts/<id>.json`. The
 * data dir is git-ignored, so these credentials never leave the machine.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { JsonStore } from "./json-store.js";
import { identityFromToken, type KiroToken, kiroTokenPath, readTokenFile, tokenUsable } from "./kiro-credentials.js";
import type { AccountInfo } from "./usage.js";

const log = createLogger("accounts");

/** Persisted, non-secret metadata about a saved account (labels for the menu). */
export interface StoredAccount {
  id: string;
  label: string;
  email?: string;
  accountType?: string;
  region?: string;
  startUrl?: string;
  /** ISO timestamp of when the snapshot was captured/refreshed. */
  savedAt: string;
}

interface AccountsData {
  accounts: StoredAccount[];
  /** When on, a turn that gives up after retries rotates through saved accounts. */
  autoRotate?: boolean;
}

/** Human label for a captured login, preferring a real email over the opaque
 *  provider name. Falls back through whoami → JWT claims → display name. */
function deriveLabel(info: AccountInfo | undefined, tok: KiroToken): string {
  const id = identityFromToken(tok);
  return (
    info?.email ||
    id.email ||
    id.name ||
    info?.startUrl ||
    tok.startUrl ||
    (info?.accountType ? `${info.accountType} account` : undefined) ||
    tok.provider ||
    "Kiro account"
  );
}

function makeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class AccountManager {
  private readonly store: JsonStore<AccountsData>;
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "accounts");
    this.store = new JsonStore<AccountsData>(join(this.dir, "index.json"), { accounts: [] });
  }

  /** All saved accounts, most recently captured first. */
  list(): StoredAccount[] {
    return [...this.store.get().accounts].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /** Whether auto-rotate-on-give-up is enabled. */
  autoRotateEnabled(): boolean {
    return this.store.get().autoRotate === true;
  }

  /** Toggle (or set) auto-rotate-on-give-up. Returns the new state. */
  setAutoRotate(on?: boolean): boolean {
    const next = on ?? !this.autoRotateEnabled();
    this.store.update((d) => {
      d.autoRotate = next;
    });
    return next;
  }

  /** The saved account matching the currently active login (by email/startUrl). */
  matchActive(key: string | undefined): StoredAccount | undefined {
    if (!key) return undefined;
    return this.store.get().accounts.find((a) => (a.email || a.startUrl) === key);
  }

  get(id: string): StoredAccount | undefined {
    return this.store.get().accounts.find((a) => a.id === id);
  }

  private snapshotPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Snapshot the currently active Kiro token as a saved account. If a saved
   * account already matches the same identity (email/startUrl), it's refreshed
   * in place instead of duplicated. Pass `customLabel` to name it yourself.
   * Throws when no usable login is active.
   */
  async captureCurrent(info?: AccountInfo, customLabel?: string): Promise<StoredAccount> {
    const tok = await readTokenFile(kiroTokenPath());
    if (!tokenUsable(tok)) {
      throw new Error("No active Kiro login to save — log in (or import from Kiro IDE) first.");
    }
    await mkdir(this.dir, { recursive: true });
    const email = info?.email ?? identityFromToken(tok!).email;
    const label = customLabel?.trim() || deriveLabel(info, tok!);
    const identity = email || info?.startUrl || tok!.startUrl;
    const existing = identity
      ? this.store.get().accounts.find((a) => (a.email || a.startUrl) === identity)
      : undefined;
    const id = existing?.id ?? makeId();
    await copyFile(kiroTokenPath(), this.snapshotPath(id));
    const meta: StoredAccount = {
      id,
      label,
      email,
      accountType: info?.accountType,
      region: info?.region ?? tok!.region,
      startUrl: info?.startUrl ?? tok!.startUrl,
      savedAt: new Date().toISOString(),
    };
    this.store.update((d) => {
      const idx = d.accounts.findIndex((a) => a.id === id);
      if (idx >= 0) d.accounts[idx] = meta;
      else d.accounts.push(meta);
    });
    log.info(`captured account ${label} (${id})`);
    return meta;
  }

  /**
   * Make a saved account the active Kiro login by copying its snapshot over the
   * live token file. The caller must restart the ACP agent afterwards so the
   * new credentials take effect. Throws when the snapshot is missing/expired.
   */
  async switchTo(id: string): Promise<StoredAccount> {
    const meta = this.get(id);
    if (!meta) throw new Error("That account is no longer saved.");
    const snap = this.snapshotPath(id);
    const tok = await readTokenFile(snap);
    if (!tokenUsable(tok)) {
      throw new Error(`Saved login for ${meta.label} is incomplete — re-add it with a fresh login.`);
    }
    await mkdir(join(kiroTokenPath(), ".."), { recursive: true });
    await copyFile(snap, kiroTokenPath());
    log.info(`switched active login to ${meta.label} (${id})`);
    return meta;
  }

  /** Give a saved account a custom label. Returns the updated meta. */
  rename(id: string, label: string): StoredAccount | undefined {
    const clean = label.trim();
    if (!clean) return this.get(id);
    let updated: StoredAccount | undefined;
    this.store.update((d) => {
      const a = d.accounts.find((x) => x.id === id);
      if (a) {
        a.label = clean;
        updated = a;
      }
    });
    return updated;
  }

  /** Forget a saved account (removes its snapshot + metadata). */
  async forget(id: string): Promise<boolean> {
    const existed = !!this.get(id);
    await rm(this.snapshotPath(id), { force: true }).catch(() => {});
    this.store.update((d) => {
      d.accounts = d.accounts.filter((a) => a.id !== id);
    });
    return existed;
  }

  /** Rewrite (used to keep metadata in sync); currently unused externally. */
  async touch(id: string): Promise<void> {
    const p = this.snapshotPath(id);
    const raw = await readFile(kiroTokenPath(), "utf-8").catch(() => undefined);
    if (raw) await writeFile(p, raw);
  }
}
