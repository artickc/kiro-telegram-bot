/**
 * Account info via `kiro-cli whoami`. (Kiro's full billing/quota panel isn't
 * available headlessly over ACP, so /usage shows account + live context usage.)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identityFromToken, kiroTokenPath, readTokenFile } from "./kiro-credentials.js";

const run = promisify(execFile);

export interface AccountInfo {
  accountType?: string;
  email?: string;
  region?: string;
  startUrl?: string;
}

/** Pull the first string value present under any of the given keys. */
function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export class UsageService {
  constructor(private readonly kiroCliPath: string) {}

  async account(): Promise<AccountInfo | undefined> {
    const info = (await this.whoami()) ?? {};
    // whoami reports `null` when the CLI isn't logged in (or can't use the
    // login); recover the identity (email) from the JWT so saved accounts still
    // show a real name instead of the opaque provider ("ExternalIdp").
    if (!info.email) {
      const id = identityFromToken(await readTokenFile(kiroTokenPath()));
      if (id.email) info.email = id.email;
    }
    return info.email || info.accountType || info.startUrl || info.region ? info : undefined;
  }

  /**
   * Whether `kiro-cli` currently has a USABLE login — i.e. `whoami` reports a
   * real account, not `{"account":null}`. This is the honest check: a token
   * file can exist (and even decode to an email) while the CLI still refuses it
   * (e.g. a Microsoft/organization `external_idp` login imported from Kiro IDE,
   * which kiro-cli doesn't support headlessly).
   */
  async isLoggedIn(): Promise<boolean> {
    return (await this.whoami()) !== undefined;
  }

  /** Parse `kiro-cli whoami --format json`; undefined when not logged in. */
  private async whoami(): Promise<AccountInfo | undefined> {
    try {
      const { stdout } = await run(this.kiroCliPath, ["whoami", "--format", "json"], {
        timeout: 10_000,
        encoding: "utf-8",
      });
      const match = stdout.match(/\{[\s\S]*\}/); // greedy: whole JSON object
      if (!match) return undefined;
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      // Explicit "not logged in".
      if ("account" in parsed && parsed.account === null) return undefined;
      // The payload may be flat or nested under `account`.
      const acct =
        parsed.account && typeof parsed.account === "object"
          ? (parsed.account as Record<string, unknown>)
          : parsed;
      return {
        email: pick(acct, ["email", "preferred_username", "username"]),
        accountType: pick(acct, ["accountType", "type", "license", "subscription", "tier"]),
        region: pick(acct, ["region"]),
        startUrl: pick(acct, ["startUrl", "start_url"]),
      };
    } catch {
      return undefined;
    }
  }
}
