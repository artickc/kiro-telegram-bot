/**
 * SessionRuntime — binds one Telegram chat to one Kiro ACP session and drives
 * the prompt/stream lifecycle, typing indicator, follow-up queue, live watch,
 * and per-chat preferences (project, agent, model, reasoning). State persists
 * to the settings store so it survives restarts.
 */
import { basename, join } from "node:path";
import type { Api } from "grammy";
import { type AcpClient, isTransientAcpError } from "../acp/client.js";
import type { ContentBlock, PromptResult, SessionUpdate } from "../acp/types.js";
import type { AppConfig } from "../config.js";
import { reasoningDirective } from "../app/reasoning.js";
import type { SettingsStore } from "../app/settings-store.js";
import { type PromptInput, type ReasoningEffort, textPrompt } from "../app/types.js";
import { createLogger } from "../logger.js";
import { buildTranscript, readHistory } from "../sessions/history.js";
import { TailWatcher } from "../sessions/tail.js";
import type { HistoryEntry } from "../sessions/types.js";
import { formatToolCall } from "../render/tool-call.js";
import { type FileOp, fileOpFromUpdate, mergeFileOp, summarizeFileOps, summarizeFileOpsShort } from "../render/file-summary.js";
import { isActiveStatus, renderSubagentTransition, statusKey } from "../render/subagent.js";
import type { PendingStage, SubagentInfo } from "../acp/types.js";
import { ResponseStreamer } from "../stream/streamer.js";
import { extractImagePaths, sendImages } from "./image-return.js";
import { buildContentBlocks, mergeInputs } from "./prompt-content.js";
import { backoffSchedule, formatErrorSummary, formatRetryNotice } from "./prompt-retry.js";
import { sendMarkdownDoc } from "./telegram-io.js";
import { TypingIndicator } from "./typing.js";

const log = createLogger("runtime");

const WATCH_ENTRY_MAX = 700;
const WATCH_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  tool: "\u{1F527}",
  system: "\u2139\uFE0F",
};

export type AttachResult = "resumed" | "forked";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SessionRuntime {
  sessionId: string | undefined;
  cwd: string;
  projectName: string | undefined;
  /** Invoked whenever observable state changes (for the status panel). */
  onStateChange: (() => void) | undefined;

  private busy = false;
  private cancelled = false;
  private readonly queue: PromptInput[] = [];
  private streamer: ResponseStreamer | undefined;
  private readonly typing: TypingIndicator;
  private shownToolIds = new Set<string>();
  /** Files touched this turn (path -> operation), tracked even in background so
   *  the completion message can summarise what changed. */
  private fileOps = new Map<string, FileOp>();
  /** The full Done/summary of the most recent finished turn, replayed when you
   *  switch (back) into this session so you see how it ended. */
  private lastCompletion: string | undefined;
  /** Subagent sessionId -> last status key shown this turn (dedupe). */
  private subagentShown = new Map<string, string>();
  private turnStartedAt = 0;
  /** Telegram message id of the current turn's prompt, so replies thread to it. */
  private turnReplyTo: number | undefined;
  private imageScanText = "";
  private sentImagesThisTurn = new Set<string>();
  private readonly listener: (sessionId: string, update: SessionUpdate) => void;
  private primingContext: string | undefined;
  private watcher: TailWatcher | undefined;
  /** True when the active watch is a transient "follow" of this session's own
   *  in-flight turn (started on switch) rather than an explicit /watch of
   *  another session — follow-watches are auto-stopped when a new turn streams. */
  private watchIsFollow = false;
  private rebindPending = false;
  private sessionLive = false;
  /** Only the foreground runtime streams to Telegram; background ones stay quiet
   *  (their output lands in the session's .jsonl and shows as "unread" on switch). */
  private foreground = true;
  private readonly restartListener: () => void;
  /** Invoked when this runtime starts/stops a turn (for subagent attribution). */
  onActivity: ((busy: boolean) => void) | undefined;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly acp: AcpClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    init?: { cwd: string; projectName?: string; sessionId?: string },
  ) {
    if (init) {
      this.cwd = init.cwd;
      this.projectName = init.projectName;
      this.sessionId = init.sessionId;
    } else {
      const s = settings.get(chatId);
      this.cwd = s.projectPath ?? cfg.workspace;
      this.projectName = s.projectName;
      this.sessionId = s.sessionId;
    }
    if (this.sessionId) this.rebindPending = true; // lazily reload on first use

    this.typing = new TypingIndicator(api, chatId);
    this.listener = (sid, update) => this.onUpdate(sid, update);
    this.acp.on("session-update", this.listener);
    this.restartListener = () => {
      this.sessionLive = false;
      if (this.sessionId) this.rebindPending = true;
    };
    this.acp.on("restarted", this.restartListener);
  }

  get isBusy(): boolean {
    return this.busy;
  }
  get queueLength(): number {
    return this.queue.length;
  }
  get isWatching(): boolean {
    return this.watcher?.running ?? false;
  }
  get isForeground(): boolean {
    return this.foreground;
  }

  /** The Done/summary of this session's most recent finished turn, if any. */
  get lastTurnSummary(): string | undefined {
    return this.lastCompletion;
  }

  /** Switch live-streaming on/off. Going background seals any in-flight turn;
   *  returning to the foreground while a turn is still running resumes RICH
   *  live streaming (thinking / tools / prose) rather than a degraded tail. */
  async setForeground(value: boolean): Promise<void> {
    if (this.foreground === value) return;
    this.foreground = value;
    if (value) {
      // A turn was started here and is still in flight, but its streamer was
      // finalized when we went background. Recreate it and let onUpdate feed
      // the remaining chunks/thoughts/tools just like a normal live turn — we
      // own the agent's session/update events, so no tail-watch is needed.
      if (this.busy && !this.streamer) {
        // Any transient follow-watch of this session is now superseded.
        if (this.watchIsFollow) this.stopWatch();
        this.streamer = new ResponseStreamer(this.api, this.chatId, this.cfg.streamThrottleMs, this.turnReplyTo);
        this.typing.start();
      }
    } else {
      this.typing.stop();
      this.stopWatch();
      if (this.streamer) {
        await this.streamer.finalize().catch(() => {});
        this.streamer = undefined;
      }
    }
    this.changed();
  }
  get reasoning(): ReasoningEffort {
    return this.settings.get(this.chatId).reasoning;
  }
  get agent(): string | undefined {
    return this.settings.get(this.chatId).agent;
  }
  get model(): string | undefined {
    return this.settings.get(this.chatId).model;
  }

  /** Latest context-usage % / effort for the current session. */
  contextInfo(): { contextUsagePercentage?: number; effort?: string } | undefined {
    return this.acp.metadataFor(this.sessionId);
  }

  dispose(): void {
    this.acp.off("session-update", this.listener);
    this.acp.off("restarted", this.restartListener);
    this.typing.stop();
    this.stopWatch();
  }

  // ── sessions ───────────────────────────────────────────────────────────────

  async startNewSession(cwd: string, projectName?: string): Promise<void> {
    if (this.busy) await this.cancel();
    this.stopWatch();
    this.sessionId = await this.acp.newSession(cwd);
    this.sessionLive = true;
    this.rebindPending = false;
    this.cwd = cwd;
    this.projectName = projectName;
    await this.applySessionPrefs();
    this.persist();
    log.info(`chat ${this.chatId} -> new session ${this.sessionId} @ ${cwd}`);
    this.changed();
  }

  /** Ensure a session is live in the current ACP process (used before menus). */
  async prepare(): Promise<void> {
    await this.ensureSession();
  }

  async resumeSession(sessionId: string, cwd: string, projectName?: string): Promise<void> {
    if (!this.acp.supportsLoadSession) {
      throw new Error("This Kiro CLI build does not support loading sessions.");
    }
    if (this.busy) await this.cancel();
    this.stopWatch();
    await this.acp.loadSession(sessionId, cwd);
    this.sessionId = sessionId;
    this.sessionLive = true;
    this.rebindPending = false;
    this.cwd = cwd;
    this.projectName = projectName;
    this.persist();
    log.info(`chat ${this.chatId} -> resumed session ${sessionId} @ ${cwd}`);
    this.changed();
  }

  async attach(
    sessionId: string,
    cwd: string,
    projectName: string | undefined,
    priorEntries: HistoryEntry[],
  ): Promise<AttachResult> {
    try {
      await this.resumeSession(sessionId, cwd, projectName);
      return "resumed";
    } catch (err) {
      log.warn(`load failed (${(err as Error).message}); forking ${sessionId.slice(0, 8)}`);
      await this.startNewSession(cwd, projectName);
      if (priorEntries.length > 0) this.primingContext = buildPriming(buildTranscript(priorEntries));
      return "forked";
    }
  }

  startWatch(jsonlPath: string, follow = false): void {
    this.stopWatch();
    this.watchIsFollow = follow;
    this.watcher = new TailWatcher(jsonlPath, (entries) => void this.onWatchEntries(entries));
    this.watcher.start(true);
  }

  stopWatch(): boolean {
    if (!this.watcher) return false;
    this.watcher.stop();
    this.watcher = undefined;
    this.watchIsFollow = false;
    return true;
  }

  // ── preferences ──────────────────────────────────────────────────────────

  async setModelPref(modelId: string): Promise<{ ok: boolean; error?: string }> {
    // Persist the choice always; only talk to Kiro when a session is live in
    // the current process (set_model on an unloaded session crashes the agent).
    this.settings.update(this.chatId, { model: modelId });
    if (modelId && this.sessionLive && this.sessionId) {
      if (!this.acp.hasModel(modelId)) return { ok: false, error: `unknown model: ${modelId}` };
      try {
        await this.acp.setModel(this.sessionId, modelId);
      } catch (e) {
        this.changed();
        return { ok: false, error: (e as Error).message };
      }
    }
    this.changed();
    return { ok: true };
  }

  async setAgentPref(agent: string): Promise<void> {
    this.settings.update(this.chatId, { agent });
    if (agent && this.sessionLive && this.sessionId && this.acp.hasMode(agent)) {
      try {
        await this.acp.setMode(this.sessionId, agent);
      } catch (e) {
        log.warn(`set_mode(${agent}) failed: ${(e as Error).message}`);
      }
    }
    this.changed();
  }

  setReasoningPref(effort: ReasoningEffort): void {
    this.settings.update(this.chatId, { reasoning: effort });
    this.changed();
  }

  private async applySessionPrefs(): Promise<void> {
    const s = this.settings.get(this.chatId);
    // Drop any persisted model the agent doesn't actually offer (an unknown id
    // is silently accepted by set_model but then breaks the next prompt).
    if (s.model && !this.acp.hasModel(s.model)) {
      log.warn(`clearing invalid persisted model "${s.model}" for chat ${this.chatId}`);
      this.settings.update(this.chatId, { model: "" });
    }
    const cur = this.settings.get(this.chatId);
    // Adopt the session's current agent (mode) when the user hasn't chosen one.
    if (!cur.agent && this.acp.currentModeId) {
      this.settings.update(this.chatId, { agent: this.acp.currentModeId });
    } else if (this.sessionId && cur.agent && this.acp.hasMode(cur.agent) && cur.agent !== this.acp.currentModeId) {
      try {
        await this.acp.setMode(this.sessionId, cur.agent);
      } catch (e) {
        log.debug(`apply agent failed: ${(e as Error).message}`);
      }
    }
    if (this.sessionId && cur.model && this.acp.hasModel(cur.model)) {
      try {
        await this.acp.setModel(this.sessionId, cur.model);
      } catch (e) {
        log.debug(`apply model failed: ${(e as Error).message}`);
      }
    }
  }

  // ── prompting ──────────────────────────────────────────────────────────────

  async submit(input: PromptInput): Promise<"ran" | "queued"> {
    await this.ensureSession();
    if (this.busy) {
      this.queue.push(input);
      this.changed();
      return "queued";
    }
    void this.runTurn(input);
    return "ran";
  }

  async cancel(): Promise<boolean> {
    if (!this.busy || !this.sessionId) return false;
    this.cancelled = true;
    await this.acp.cancel(this.sessionId);
    return true;
  }

  clearQueue(): number {
    const n = this.queue.length;
    this.queue.length = 0;
    this.changed();
    return n;
  }

  drainQueueToPrompt(): PromptInput | undefined {
    if (this.queue.length === 0) return undefined;
    return mergeInputs(this.queue.splice(0, this.queue.length));
  }

  private async ensureSession(): Promise<void> {
    if (this.rebindPending && this.sessionId) {
      // The ACP process is frequently mid-restart the first time we re-bind
      // (auto-restart after a crash, or a fresh bot boot), so a single attempt
      // is flaky. Retry briefly before giving up.
      if (await this.rebindWithRetries(this.sessionId)) {
        this.sessionLive = true;
        this.rebindPending = false;
        await this.applySessionPrefs();
        log.info(`chat ${this.chatId} re-bound session ${this.sessionId.slice(0, 8)}`);
        return;
      }
      // The session genuinely can't be reloaded (its exclusive lock is held,
      // or its log/metadata is gone). Never silently drop the conversation:
      // fork a linked continuation primed with the recent transcript so the
      // thread survives — including any question the agent had just asked.
      // forkFromLostSession() only throws if the agent is fully down, in which
      // case we leave rebindPending set so the next message retries cleanly.
      await this.forkFromLostSession(this.sessionId);
      this.rebindPending = false;
      return;
    }
    if (!this.sessionId) await this.startNewSession(this.cwd, this.projectName);
  }

  /** Reload a persisted session, retrying flaky failures with a short backoff.
   *  Returns true once loaded, false after the attempts are exhausted. */
  private async rebindWithRetries(sessionId: string, attempts = 4): Promise<boolean> {
    const delays = [400, 1200, 3000]; // ≈4.6s total before giving up
    for (let i = 0; i < attempts; i++) {
      try {
        await this.acp.loadSession(sessionId, this.cwd);
        return true;
      } catch (err) {
        log.warn(
          `re-bind ${sessionId.slice(0, 8)} attempt ${i + 1}/${attempts} failed: ${(err as Error).message}`,
        );
        if (i === attempts - 1) return false;
        await sleep(delays[Math.min(i, delays.length - 1)]!);
      }
    }
    return false;
  }

  /** Continue a session we could not reload by forking a fresh one primed with
   *  the lost session's recent transcript, so no context is dropped. */
  private async forkFromLostSession(lostId: string): Promise<void> {
    let transcript = "";
    try {
      const entries = readHistory(join(this.cfg.sessionsDir, `${lostId}.jsonl`), 24);
      if (entries.length > 0) transcript = buildTranscript(entries);
    } catch {
      /* no recoverable history on disk */
    }
    log.warn(
      `chat ${this.chatId} could not reload ${lostId.slice(0, 8)}; forking a linked continuation` +
        (transcript ? " (primed with recent transcript)" : ""),
    );
    await this.startNewSession(this.cwd, this.projectName); // sets a fresh, live sessionId
    if (transcript) this.primingContext = buildPriming(transcript);
    if (this.foreground) {
      await this.notify(
        transcript
          ? "\u{1F517} Couldn't reopen the previous session, so I started a linked continuation primed with the recent transcript \u2014 we can keep going from where we left off."
          : "\u{1F517} Couldn't reopen the previous session, so I started a fresh one here.",
      );
    }
  }

  private async runTurn(input: PromptInput): Promise<void> {
    this.busy = true;
    this.cancelled = false;
    this.turnReplyTo = input.replyTo;
    this.shownToolIds = new Set();
    this.fileOps = new Map();
    this.subagentShown = new Map();
    // A new streamed turn supersedes any transient "follow" watch of this same
    // session's previous in-flight turn (avoids duplicated output).
    if (this.watchIsFollow) this.stopWatch();
    const live = this.foreground;
    this.streamer = live
      ? new ResponseStreamer(this.api, this.chatId, this.cfg.streamThrottleMs, this.turnReplyTo)
      : undefined;
    if (live) this.typing.start();
    this.activity(true);
    this.changed();
    const startedAt = Date.now();
    this.turnStartedAt = startedAt;
    this.imageScanText = "";
    this.sentImagesThisTurn = new Set();

    const content = buildContentBlocks(input, {
      reasoning: reasoningDirective(this.reasoning),
      priming: this.primingContext,
    });
    this.primingContext = undefined;

    try {
      const outcome = await this.runPromptWithRetries(content);
      const streamedOutput = this.streamer?.hasOutput ?? false;
      if (this.streamer) await this.streamer.finalize(this.hashtags());
      if (this.foreground) await this.sendTurnImages();
      // Always build the completion (records `lastCompletion` so switching back
      // to this session can replay its Done + summary). Only PING the chat for
      // the foreground turn, or a background turn when NOTIFY_OTHER_SESSIONS is on.
      const canPing = this.foreground || this.cfg.notifyOtherSessions;
      if (outcome.result || this.cancelled) {
        const live = this.completionMessage(outcome.result?.stopReason, startedAt, streamedOutput);
        if (canPing) await this.notify(live, { loud: true, replyTo: this.turnReplyTo });
      } else if (outcome.error) {
        const transient = isTransientAcpError(outcome.error);
        const live = this.errorMessage(outcome.error, startedAt, outcome.attempts, transient);
        if (canPing) await this.notify(live, { loud: true, replyTo: this.turnReplyTo });
      }
    } catch (err) {
      // Unexpected failure outside the prompt path (e.g. while finalizing).
      await this.streamer?.finalize().catch(() => {});
      const msg = `\u274C Error after ${fmtDuration(Date.now() - startedAt)}: ${(err as Error).message}`;
      this.lastCompletion = msg;
      if (this.foreground || this.cfg.notifyOtherSessions) {
        const from = this.foreground ? "" : `\u{1F4E8} From other session ${this.sessionTag()}\n`;
        await this.notify(`${from}${msg}`, { loud: true, replyTo: this.turnReplyTo });
      }
    } finally {
      this.typing.stop();
      this.streamer = undefined;
      this.busy = false;
      this.activity(false);
      // The in-flight turn we may have been following live is over.
      if (this.watchIsFollow) this.stopWatch();
      this.changed();
    }

    await this.flushQueue();
  }

  private activity(busy: boolean): void {
    try {
      this.onActivity?.(busy);
    } catch {
      /* non-fatal */
    }
  }

  /**
   * Show subagent ("crew") status transitions for the given (already
   * chat-attributed) subagents, so the user sees progress while the main agent
   * waits on them. No-op unless this runtime is the live foreground turn.
   */
  renderSubagents(subagents: SubagentInfo[], _pending: PendingStage[]): void {
    if (!this.cfg.showSubagents) return;
    if (!this.foreground || !this.busy || !this.streamer) return;
    for (const s of subagents) {
      const key = statusKey(s);
      const prev = this.subagentShown.get(s.sessionId);
      if (prev === key) continue;
      const kind: "start" | "status" = prev === undefined && isActiveStatus(key) ? "start" : "status";
      this.subagentShown.set(s.sessionId, key);
      const md = renderSubagentTransition(s, kind);
      if (md) this.streamer.addTool(md);
    }
  }

  /**
   * Run the prompt, retrying *transient* agent errors (e.g. "high volume of
   * traffic" / -32603) with an exponential backoff (6s → 12s → 24s → 48s → 60s,
   * then give up). The real error is shown to the user on every failed attempt.
   *
   * We only retry while the turn has produced **no streamed output** (so tools
   * aren't re-run and text isn't duplicated) and the user hasn't cancelled.
   * Returns the result, or the last error once retries are exhausted.
   */
  private async runPromptWithRetries(
    content: ContentBlock[],
  ): Promise<{ result?: PromptResult; error?: Error; attempts: number }> {
    const delays = this.cfg.promptRetryAttempts > 0 ? backoffSchedule(this.cfg.promptRetryAttempts) : [];
    const totalAttempts = delays.length + 1;
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const result = await this.acp.prompt(this.sessionId!, content);
        return { result, attempts: attempt };
      } catch (err) {
        const error = err as Error;
        const willRetry =
          attempt <= delays.length &&
          !this.cancelled &&
          !this.streamer?.hasOutput &&
          isTransientAcpError(error);
        if (!willRetry) return { error, attempts: attempt };
        const waitMs = delays[attempt - 1]!;
        if (this.foreground) await this.notify(formatRetryNotice(error, attempt + 1, totalAttempts, waitMs));
        if (await this.interruptibleSleep(waitMs)) return { error, attempts: attempt };
      }
    }
  }

  /** Sleep that returns true early if the user cancels the turn meanwhile. */
  private async interruptibleSleep(ms: number): Promise<boolean> {
    const step = 500;
    for (let waited = 0; waited < ms; waited += step) {
      if (this.cancelled) return true;
      await sleep(Math.min(step, ms - waited));
    }
    return this.cancelled;
  }

  /** Send any fresh images the agent produced this turn (screenshots, etc.). */
  private async sendTurnImages(): Promise<void> {
    if (!this.cfg.sendAgentImages || !this.imageScanText) return;
    const paths = extractImagePaths(this.imageScanText, this.cwd);
    if (paths.length === 0) return;
    try {
      await sendImages(this.api, this.chatId, paths, {
        since: this.turnStartedAt,
        already: this.sentImagesThisTurn,
        max: this.cfg.agentImagesMax,
      });
    } catch {
      /* non-fatal */
    }
  }

  /** Build the "turn finished" message and record `lastCompletion` (the full
   *  in-session version with the file list). Foreground gets the full version;
   *  a background turn gets a labelled "other session" ping with short counts. */
  private completionMessage(stopReason: string | undefined, startedAt: number, streamedOutput: boolean): string {
    const head = this.doneHead(stopReason, startedAt, streamedOutput);
    const tags = this.hashtags();
    const base = `${head}\n${summarizeFileOps(this.fileOps, this.cwd)}`;
    this.lastCompletion = `${base}\n\n${tags}`; // switch-replay stays searchable
    if (this.foreground) {
      // The streamed response already carries the tag footer; only add tags to
      // the Done line when there was no response to tag (tool-only / no output).
      return streamedOutput ? base : `${base}\n\n${tags}`;
    }
    return `\u{1F4E8} From other session ${this.sessionTag()}\n${head}\n${summarizeFileOpsShort(this.fileOps)}\n\n${tags}`;
  }

  /** The compact one-line status of a finished turn (no "end_turn" noise). */
  private doneHead(stopReason: string | undefined, startedAt: number, streamedOutput: boolean): string {
    const elapsed = fmtDuration(Date.now() - startedAt);
    if (this.cancelled || stopReason === "cancelled") return `\u23F9 Stopped \u00B7 ${elapsed}`;
    const reason = stopReason && stopReason !== "end_turn" ? ` \u00B7 ${stopReason}` : "";
    const ctx = this.contextInfo()?.contextUsagePercentage;
    const ctxStr = ctx !== undefined ? ` \u00B7 ctx ${ctx.toFixed(0)}%` : "";
    // Only claim "no text output" when we were actually streaming (foreground).
    const noOut = this.foreground && !streamedOutput ? " \u00B7 no text output" : "";
    return `\u2705 Done${reason} \u00B7 ${elapsed}${ctxStr}${noOut}`;
  }

  /** Build the turn-failed message and record `lastCompletion`. */
  private errorMessage(error: Error, startedAt: number, attempts: number, transient: boolean): string {
    const summary = formatErrorSummary(error, fmtDuration(Date.now() - startedAt), attempts, transient);
    const files = this.fileOps.size > 0 ? `\n${summarizeFileOps(this.fileOps, this.cwd)}` : "";
    const tags = this.hashtags();
    this.lastCompletion = `${summary}${files}\n\n${tags}`;
    if (this.foreground) return this.lastCompletion;
    const shortFiles = this.fileOps.size > 0 ? `\n${summarizeFileOpsShort(this.fileOps)}` : "";
    return `\u{1F4E8} From other session ${this.sessionTag()}\n${summary}${shortFiles}\n\n${tags}`;
  }

  /** "[project · 1a2b3c4d]" — identifies which background session a ping is from. */
  private sessionTag(): string {
    const name = this.projectName || basename(this.cwd) || "session";
    const id = this.sessionId ? ` \u00B7 ${this.sessionId.slice(0, 8)}` : "";
    return `[${name}${id}]`;
  }

  /** Searchable Telegram hashtags so you can pull up every message of a session,
   *  project, model or reasoning level by tapping the tag. */
  private hashtags(): string {
    const tags = [
      `#proj_${tagSafe(this.projectName || basename(this.cwd) || "none")}`,
      `#model_${tagSafe(this.model || "default")}`,
      `#reason_${tagSafe(this.reasoning)}`,
    ];
    if (this.sessionId) tags.splice(1, 0, `#sess_${tagSafe(this.sessionId.slice(0, 8))}`);
    return tags.join(" ");
  }

  private async flushQueue(): Promise<void> {
    if (this.queue.length === 0 || this.busy) return;
    const batch = mergeInputs(this.queue.splice(0, this.queue.length));
    if (this.foreground) await this.notify("\u25B6\uFE0F Processing queued message\u2026");
    void this.runTurn(batch);
  }

  private onUpdate(sessionId: string, update: SessionUpdate): void {
    if (!this.busy || sessionId !== this.sessionId) return;
    const kind = update.sessionUpdate;

    // Accumulate the turn's file-change summary + image-scan text even when this
    // session is in the background (its output isn't streamed here, but the
    // completion message still reports what changed / which images were made).
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (update.rawInput) this.imageScanText += " " + JSON.stringify(update.rawInput);
      if (update.title) this.imageScanText += " " + update.title;
      const fo = fileOpFromUpdate(update);
      if (fo) this.fileOps.set(fo.path, mergeFileOp(this.fileOps.get(fo.path), fo.op));
    } else if (kind === "agent_message_chunk") {
      const text = update.content?.text;
      if (typeof text === "string") this.imageScanText += text;
    }

    // Only the live foreground turn streams to Telegram.
    if (!this.foreground || !this.streamer) return;

    if (kind === "agent_message_chunk") {
      const text = update.content?.text;
      if (typeof text === "string") this.streamer.appendOutput(text);
      return;
    }
    if (kind === "agent_thought_chunk") {
      const text = update.content?.text;
      if (typeof text === "string") this.streamer.appendThought(text);
      return;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      if (!this.cfg.showToolCalls) return;
      const id = update.toolCallId || `${kind}:${update.title ?? ""}`;
      if (this.shownToolIds.has(id)) return;
      this.shownToolIds.add(id);
      const md = formatToolCall(update, {
        showDiffs: this.cfg.showEditDiffs,
        diffMaxLines: this.cfg.diffMaxLines,
      });
      if (md) this.streamer.addTool(md);
    }
  }

  private persist(): void {
    if (!this.foreground) return; // only the foreground session is the chat's restored default
    this.settings.update(this.chatId, {
      projectPath: this.cwd,
      projectName: this.projectName,
      sessionId: this.sessionId,
    });
  }

  private changed(): void {
    try {
      this.onStateChange?.();
    } catch {
      /* non-fatal */
    }
  }

  private async notify(text: string, opts?: { loud?: boolean; replyTo?: number }): Promise<void> {
    try {
      const extra: Record<string, unknown> = opts?.loud ? { disable_notification: false } : {};
      if (opts?.replyTo !== undefined) {
        extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
      }
      await this.api.sendMessage(this.chatId, text, extra);
    } catch {
      /* non-fatal */
    }
  }

  private async onWatchEntries(entries: HistoryEntry[]): Promise<void> {
    const body = entries
      .map((e) => {
        const icon = WATCH_ICON[e.role] ?? "\u2022";
        if (e.role === "tool") return `${icon} ${e.tool ? `\`${e.tool}\`` : "tool"}`;
        const text = e.text.length > WATCH_ENTRY_MAX ? e.text.slice(0, WATCH_ENTRY_MAX) + " …" : e.text;
        return `${icon} ${text}`;
      })
      .filter(Boolean)
      .join("\n\n");
    if (body.trim()) await sendMarkdownDoc(this.api, this.chatId, body);
  }
}

/** Sanitise a value into a Telegram-safe hashtag body (letters/digits/_ only). */
function tagSafe(v: string): string {
  const s = v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return s || "none";
}

/** Format an elapsed duration compactly (e.g. "8s", "2m 13s", "1h 4m"). */
function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}


function buildPriming(transcript: string): string {
  return [
    "You are resuming a conversation that is currently still running in another",
    "window on this machine, so this is a linked continuation. Below is the recent",
    "transcript for context — use it to continue seamlessly.",
    "",
    "=== RECENT TRANSCRIPT ===",
    transcript,
    "=== END TRANSCRIPT ===",
  ].join("\n");
}

/** Convenience for callers that only have text. */
export { textPrompt };
