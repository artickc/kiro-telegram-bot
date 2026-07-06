/**
 * Auto-rotate-on-give-up. When a turn exhausts its retries (and auto-fork can't
 * recover it), the runtime can cycle through the OTHER saved Kiro accounts,
 * retrying the same prompt on each — useful when the active account is
 * throttled, out of quota, or its backend keeps returning "dispatch failure".
 *
 * The rotation is bounded to a SINGLE pass over the saved accounts (no infinite
 * loop): each account is tried once; the first that succeeds wins and stays
 * active, otherwise the runtime reports the error gathered from every account.
 *
 * Account switching is process-global (one machine → one active Kiro login), so
 * a rotation restarts the shared agent and affects every chat — intended, since
 * the whole point is to move everyone onto a working login.
 */
import type { AcpClient } from "../acp/client.js";
import type { AccountManager } from "../app/accounts.js";
import type { UsageService } from "../app/usage.js";

export interface RotationTarget {
  id: string;
  label: string;
}

export interface AccountRotator {
  /** Whether auto-rotate is switched on. */
  enabled(): boolean;
  /** Saved accounts to try, EXCLUDING the one that's currently active. */
  targets(): Promise<RotationTarget[]>;
  /** Make a saved account active (copy token + restart agent). Throws on error. */
  activate(id: string): Promise<void>;
}

export class AccountRotatorImpl implements AccountRotator {
  constructor(
    private readonly accounts: AccountManager,
    private readonly acp: AcpClient,
    private readonly usage: UsageService,
  ) {}

  enabled(): boolean {
    return this.accounts.autoRotateEnabled();
  }

  async targets(): Promise<RotationTarget[]> {
    const list = this.accounts.list();
    const acct = await this.usage.account().catch(() => undefined);
    const activeId = this.accounts.matchActive(acct?.email || acct?.startUrl)?.id;
    return list.filter((a) => a.id !== activeId).map((a) => ({ id: a.id, label: a.label }));
  }

  async activate(id: string): Promise<void> {
    await this.accounts.switchTo(id);
    await this.acp.restart();
  }
}
