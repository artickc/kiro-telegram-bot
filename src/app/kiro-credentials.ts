/**
 * Low-level access to Kiro's on-disk login credential — the AWS SSO device
 * cache token that both Kiro CLI and Kiro IDE authenticate with. Everything
 * account-related (import from Kiro IDE, multi-account snapshot/switch) is built
 * on top of this single file:
 *
 *   ~/.aws/sso/cache/kiro-auth-token.json
 *
 * It carries the logged-in identity (accessToken + refreshToken + expiry). We
 * never transmit it anywhere; we only read it, validate it, and copy it between
 * the live cache path and per-account snapshots kept under the bot's data dir.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("kiro-cred");

/**
 * Guidance shown when a token is present but kiro-cli won't accept it as a
 * login. The usual cause: an organization / Microsoft (Entra) login whose token
 * was copied from Kiro IDE — kiro-cli's own organization sign-in runs through a
 * browser (`app.kiro.dev`), so it must be completed with `kiro-cli login` on the
 * machine hosting the bot; the bot then picks it up.
 */
export const UNSUPPORTED_LOGIN_HELP =
  "kiro-cli didn't accept this token as a login. For an organization / Microsoft " +
  "(Entra) account, run `kiro-cli login` in a terminal on the machine hosting the " +
  "bot and pick \u201CYour organization\u201D (it opens in a browser) \u2014 then use " +
  "/accounts \u2192 Save current login. Or use /reauth for Builder ID / Google / " +
  "GitHub / IAM Identity Center.";

/** AWS SSO cache directory Kiro reads/writes its device token from. */
export function ssoCacheDir(): string {
  return join(homedir(), ".aws", "sso", "cache");
}

/** The single token file that carries the currently active Kiro identity. */
export function kiroTokenPath(): string {
  return join(ssoCacheDir(), "kiro-auth-token.json");
}

/** Shape of the Kiro/AWS SSO device token file (only the fields we read). */
export interface KiroToken {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  authMethod?: string;
  provider?: string;
  issuerUrl?: string;
  startUrl?: string;
  region?: string;
  clientId?: string;
  scopes?: string[];
}

/** Read + parse a token JSON file. Returns undefined when missing/unparseable. */
export async function readTokenFile(path: string): Promise<KiroToken | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as KiroToken;
  } catch {
    return undefined;
  }
}

/**
 * A token is usable when it carries the access + refresh credential pair. We
 * deliberately DON'T reject on `expiresAt`: that's the short-lived access-token
 * expiry, which Kiro refreshes automatically from the refresh token — so an
 * "expired" access token with a live refresh token is still a valid login.
 */
export function tokenUsable(tok: KiroToken | undefined): boolean {
  return !!tok?.accessToken && !!tok?.refreshToken;
}

/** A short human label for a token's identity (provider / method / issuer). */
export function tokenLabel(tok: KiroToken | undefined): string | undefined {
  if (!tok) return undefined;
  return identityFromToken(tok).email || tok.startUrl || tok.provider || tok.authMethod || tok.issuerUrl;
}

export interface TokenIdentity {
  email?: string;
  name?: string;
}

/** Decode the base64url JWT payload segment; undefined if not a JWT. */
function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort identity (email + display name) for a token. Kiro's `whoami` can
 * report `null` when the short-lived access token has lapsed, so we read the
 * identity straight from the JWT access-token claims instead — covering AWS
 * Builder ID (`email`), social, and organization/Entra (`preferred_username`)
 * logins, which all otherwise surface as the opaque provider name "ExternalIdp".
 */
export function identityFromToken(tok: KiroToken | undefined): TokenIdentity {
  if (!tok?.accessToken) return {};
  const claims = decodeJwtPayload(tok.accessToken);
  if (!claims) return {};
  const str = (k: string): string | undefined => (typeof claims[k] === "string" ? (claims[k] as string) : undefined);
  const emailish = str("email") || str("preferred_username") || str("upn");
  const email = emailish && emailish.includes("@") ? emailish : undefined;
  const name = str("name") || str("given_name");
  return { email, name };
}

/**
 * Roots that may hold a Kiro login token dropped by the desktop IDE or a prior
 * CLI login. The AWS SSO cache is the shared, canonical location (Kiro CLI and
 * Kiro IDE both write it there); the IDE storage dirs are scanned as a fallback
 * in case a future build keeps a plain token file of its own.
 */
function importSearchRoots(): string[] {
  const home = homedir();
  const roots = [ssoCacheDir(), join(home, ".kiro")];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  if (appData) roots.push(join(appData, "Kiro", "User", "globalStorage", "kiro.kiroagent"));
  if (localAppData) roots.push(join(localAppData, "Kiro", "User", "globalStorage", "kiro.kiroagent"));
  // macOS / Linux IDE storage locations.
  roots.push(join(home, "Library", "Application Support", "Kiro", "User", "globalStorage", "kiro.kiroagent"));
  roots.push(join(home, ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent"));
  return roots.filter((r) => existsSync(r));
}

/** Bounded recursive search for files literally named `kiro-auth-token.json`. */
async function findTokenFiles(root: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0 || out.length >= 32) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isFile() && e.name === "kiro-auth-token.json") out.push(full);
    else if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
      await findTokenFiles(full, depth - 1, out);
    }
  }
}

export interface ImportCandidate {
  path: string;
  token: KiroToken;
  mtimeMs: number;
}

/**
 * Locate the freshest USABLE Kiro login token on this machine (from the shared
 * SSO cache or an IDE storage dir). Returns undefined when no valid token is
 * present — the caller then tells the user to log into Kiro IDE first.
 */
export async function findImportableToken(): Promise<ImportCandidate | undefined> {
  const paths: string[] = [];
  for (const root of importSearchRoots()) {
    if (root === ssoCacheDir()) paths.push(kiroTokenPath());
    else await findTokenFiles(root, 3, paths);
  }
  const seen = new Set<string>();
  const candidates: ImportCandidate[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    const token = await readTokenFile(p);
    if (!tokenUsable(token)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(p)).mtimeMs;
    } catch {
      /* ignore */
    }
    candidates.push({ path: p, token: token!, mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0];
}

/** Copy a token file into the live SSO cache so Kiro logs in as that identity. */
export async function installToken(fromPath: string): Promise<void> {
  const dest = kiroTokenPath();
  if (fromPath === dest) return; // already the active token
  await mkdir(ssoCacheDir(), { recursive: true });
  await copyFile(fromPath, dest);
  log.info(`installed Kiro token from ${fromPath}`);
}
