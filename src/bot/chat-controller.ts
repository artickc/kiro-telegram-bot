/**
 * ChatController — manages the set of Kiro sessions a single Telegram chat is
 * controlling, with exactly one "foreground" session streaming live. Other
 * (background) sessions keep running quietly; their output lands in the
 * session's .jsonl and is replayed as "unread" when you switch to them.
 */
import { basename } from "node:path";
import type { Api } from "grammy";
import type { AcpClient } from "../acp/client.js";
import type { SettingsStore } from "../app/settings-store.js";
import type { AppConfig } from "../config.js";
import { jsonlSize, readEntriesFrom, readHistory } from "../sessions/history.js";
import type { SessionStore } from "../sessions/store.js";
import type { HistoryEntry } from "../sessions/types.js";
import { SessionRuntime } from "./session-runtime.js";

export interface RunningSession {
  sessionId?: string;
  projectName: string;
  busy: boolean;
  foreground: boolean;
  unread: number;
}

export interface SwitchResult {
  rt: SessionRuntime;
  sessionId?: string;
  projectName?: string;
  busy: boolean;
  unread: HistoryEntry[];
  firstView: boolean;
  alreadyForeground: boolean;
}

export class ChatController {
  private readonly runtimes: SessionRuntime[] = [];
  private fg: SessionRuntime | undefined;
  private readonly lastRead = new Map<string, number>();
  private restored = false;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly acp: AcpClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    private readonly store: SessionStore,
    private readonly refresh: (chatId: number) => void,
    private readonly notifyActivity: (busy: boolean) => void,
  ) {}

  /** The current foreground runtime (created/restored lazily). */
  foreground(): SessionRuntime {
    this.ensureRestored();
    if (!this.fg) {
      const s = this.settings.get(this.chatId);
      const rt = this.create({ cwd: s.projectPath ?? this.cfg.workspace, projectName: s.projectName, sessionId: s.sessionId });
      this.runtimes.push(rt);
      this.fg = rt;
    }
    return this.fg;
  }

  /** List the controlled sessions (for /running). */
  list(): RunningSession[] {
    this.ensureRestored();
    return this.runtimes.map((rt) => ({
      sessionId: rt.sessionId,
      projectName: rt.projectName ?? basename(rt.cwd),
      busy: rt.isBusy,
      foreground: rt.isForeground,
      unread: this.unreadCount(rt),
    }));
  }

  /** Start a brand-new session and bring it to the foreground. */
  async addNew(cwd: string, projectName?: string): Promise<SessionRuntime> {
    this.ensureRestored();
    await this.background(this.fg);
    const rt = this.create({ cwd, projectName });
    this.runtimes.push(rt);
    this.fg = rt;
    await rt.startNewSession(cwd, projectName);
    this.markSeen(rt);
    this.persist();
    return rt;
  }

  /**
   * Connect to a session with resume-or-fork semantics (used by /sessions),
   * adding it as a controlled session and bringing it to the foreground.
   */
  async addAttach(
    sessionId: string,
    cwd: string,
    projectName: string | undefined,
    priorEntries: HistoryEntry[],
  ): Promise<{ rt: SessionRuntime; result: "resumed" | "forked"; alreadyControlled: boolean }> {
    this.ensureRestored();
    if (this.runtimes.some((r) => r.sessionId === sessionId)) {
      const sw = await this.switchTo(sessionId);
      return { rt: sw!.rt, result: "resumed", alreadyControlled: true };
    }
    await this.background(this.fg);
    const rt = this.create({ cwd, projectName, sessionId });
    this.runtimes.push(rt);
    this.fg = rt;
    const result = await rt.attach(sessionId, cwd, projectName, priorEntries);
    this.markSeen(rt);
    this.persist();
    return { rt, result, alreadyControlled: false };
  }

  /** Connect to an existing session: switch if already controlled, else add it. */
  async addResume(sessionId: string, cwd: string, projectName?: string): Promise<SwitchResult> {
    this.ensureRestored();
    if (this.runtimes.some((r) => r.sessionId === sessionId)) {
      return (await this.switchTo(sessionId))!;
    }
    await this.background(this.fg);
    const rt = this.create({ cwd, projectName, sessionId });
    this.runtimes.push(rt);
    this.fg = rt;
    await rt.prepare().catch(() => {});
    const path = this.store.jsonlPath(sessionId);
    const unread = readHistory(path, 12);
    this.lastRead.set(sessionId, jsonlSize(path));
    this.persist();
    return { rt, sessionId, projectName, busy: rt.isBusy, unread, firstView: true, alreadyForeground: false };
  }

  /** Switch the foreground to an already-controlled session. */
  async switchTo(sessionId: string): Promise<SwitchResult | undefined> {
    this.ensureRestored();
    const rt = this.runtimes.find((r) => r.sessionId === sessionId);
    if (!rt) return undefined;
    if (rt === this.fg) {
      return { rt, sessionId, projectName: rt.projectName, busy: rt.isBusy, unread: [], firstView: false, alreadyForeground: true };
    }
    await this.background(this.fg);
    this.fg = rt;
    await rt.setForeground(true);
    await rt.prepare().catch(() => {});

    const path = this.store.jsonlPath(sessionId);
    const seen = this.lastRead.get(sessionId);
    let unread: HistoryEntry[] = [];
    let firstView = false;
    if (seen !== undefined) {
      unread = readEntriesFrom(path, seen).entries;
    } else {
      unread = readHistory(path, 12);
      firstView = true;
    }
    this.lastRead.set(sessionId, jsonlSize(path));
    // No tail-watch here: setForeground(true) above already resumed RICH live
    // streaming for the in-flight turn via the agent's own session/update
    // events. Tailing the .jsonl too would double-render every update.
    this.persist();
    return { rt, sessionId, projectName: rt.projectName, busy: rt.isBusy, unread, firstView, alreadyForeground: false };
  }

  /** Stop controlling a session (does not kill it). */
  async close(sessionId: string): Promise<boolean> {
    this.ensureRestored();
    const idx = this.runtimes.findIndex((r) => r.sessionId === sessionId);
    if (idx === -1) return false;
    const rt = this.runtimes[idx]!;
    rt.dispose();
    this.runtimes.splice(idx, 1);
    this.lastRead.delete(sessionId);
    if (this.fg === rt) {
      this.fg = this.runtimes[0];
      if (this.fg) await this.fg.setForeground(true);
    }
    this.persist();
    return true;
  }

  count(): number {
    this.ensureRestored();
    return this.runtimes.length;
  }

  findBySession(sessionId: string): boolean {
    return this.runtimes.some((r) => r.sessionId === sessionId);
  }

  dispose(): void {
    for (const rt of this.runtimes) rt.dispose();
    this.runtimes.length = 0;
    this.fg = undefined;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ensureRestored(): void {
    if (this.restored) return;
    this.restored = true;
    const s = this.settings.get(this.chatId);
    for (const cs of s.controlledSessions ?? []) {
      if (!cs.sessionId) continue;
      this.runtimes.push(this.create({ cwd: cs.projectPath, projectName: cs.projectName, sessionId: cs.sessionId }));
    }
    if (this.runtimes.length > 0) {
      const fg = this.runtimes.find((r) => r.sessionId === s.foregroundSessionId) ?? this.runtimes[0]!;
      for (const r of this.runtimes) void r.setForeground(r === fg);
      this.fg = fg;
    }
  }

  private create(init: { cwd: string; projectName?: string; sessionId?: string }): SessionRuntime {
    const rt = new SessionRuntime(this.api, this.chatId, this.acp, this.cfg, this.settings, init);
    rt.onStateChange = () => this.refresh(this.chatId);
    rt.onActivity = (busy) => this.notifyActivity(busy);
    return rt;
  }

  private async background(rt: SessionRuntime | undefined): Promise<void> {
    if (!rt) return;
    this.markSeen(rt);
    await rt.setForeground(false);
  }

  private markSeen(rt: SessionRuntime): void {
    if (rt.sessionId) this.lastRead.set(rt.sessionId, jsonlSize(this.store.jsonlPath(rt.sessionId)));
  }

  private unreadCount(rt: SessionRuntime): number {
    if (!rt.sessionId || rt.isForeground) return 0;
    const seen = this.lastRead.get(rt.sessionId);
    if (seen === undefined) return 0;
    return readEntriesFrom(this.store.jsonlPath(rt.sessionId), seen).entries.length;
  }

  private persist(): void {
    const controlled = this.runtimes
      .filter((r) => r.sessionId)
      .map((r) => ({ sessionId: r.sessionId, projectPath: r.cwd, projectName: r.projectName }));
    this.settings.update(this.chatId, {
      controlledSessions: controlled,
      foregroundSessionId: this.fg?.sessionId,
      // Keep the single-session restore fields aligned with the foreground so
      // the pinned status panel and a fresh restore never show a project that
      // belongs to a different (previously-foreground) session.
      sessionId: this.fg?.sessionId,
      projectPath: this.fg?.cwd,
      projectName: this.fg?.projectName,
    });
  }
}
