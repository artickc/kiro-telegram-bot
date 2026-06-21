/**
 * SessionRuntime — binds one Telegram chat to one Kiro ACP session and drives
 * the prompt/stream lifecycle, typing indicator, follow-up queue, live watch,
 * and per-chat preferences (project, agent, model, reasoning). State persists
 * to the settings store so it survives restarts.
 */
import type { Api } from "grammy";
import type { AcpClient } from "../acp/client.js";
import type { SessionUpdate } from "../acp/types.js";
import type { AppConfig } from "../config.js";
import { reasoningDirective } from "../app/reasoning.js";
import type { SettingsStore } from "../app/settings-store.js";
import { type PromptInput, type ReasoningEffort, textPrompt } from "../app/types.js";
import { createLogger } from "../logger.js";
import { buildTranscript } from "../sessions/history.js";
import { TailWatcher } from "../sessions/tail.js";
import type { HistoryEntry } from "../sessions/types.js";
import { formatToolCall } from "../render/tool-call.js";
import { ResponseStreamer } from "../stream/streamer.js";
import { buildContentBlocks, mergeInputs } from "./prompt-content.js";
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
  private readonly listener: (sessionId: string, update: SessionUpdate) => void;
  private primingContext: string | undefined;
  private watcher: TailWatcher | undefined;
  private rebindPending = false;
  private readonly restartListener: () => void;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly acp: AcpClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
  ) {
    const s = settings.get(chatId);
    this.cwd = s.projectPath ?? cfg.workspace;
    this.projectName = s.projectName;
    this.sessionId = s.sessionId;
    if (this.sessionId) this.rebindPending = true; // lazily reload on first use

    this.typing = new TypingIndicator(api, chatId);
    this.listener = (sid, update) => this.onUpdate(sid, update);
    this.acp.on("session-update", this.listener);
    this.restartListener = () => {
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
    this.cwd = cwd;
    this.projectName = projectName;
    await this.applySessionPrefs();
    this.persist();
    log.info(`chat ${this.chatId} -> new session ${this.sessionId} @ ${cwd}`);
    this.changed();
  }

  async resumeSession(sessionId: string, cwd: string, projectName?: string): Promise<void> {
    if (!this.acp.supportsLoadSession) {
      throw new Error("This Kiro CLI build does not support loading sessions.");
    }
    if (this.busy) await this.cancel();
    this.stopWatch();
    await this.acp.loadSession(sessionId, cwd);
    this.sessionId = sessionId;
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

  startWatch(jsonlPath: string): void {
    this.stopWatch();
    this.watcher = new TailWatcher(jsonlPath, (entries) => void this.onWatchEntries(entries));
    this.watcher.start(true);
  }

  stopWatch(): boolean {
    if (!this.watcher) return false;
    this.watcher.stop();
    this.watcher = undefined;
    return true;
  }

  // ── preferences ──────────────────────────────────────────────────────────

  async setModelPref(modelId: string): Promise<{ ok: boolean; error?: string }> {
    this.settings.update(this.chatId, { model: modelId });
    if (this.sessionId && modelId) {
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
    if (this.sessionId && agent) {
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
    // Adopt the session's current agent (mode) when the user hasn't chosen one.
    if (!s.agent && this.acp.currentModeId) {
      this.settings.update(this.chatId, { agent: this.acp.currentModeId });
    } else if (this.sessionId && s.agent && this.acp.hasMode(s.agent) && s.agent !== this.acp.currentModeId) {
      try {
        await this.acp.setMode(this.sessionId, s.agent);
      } catch (e) {
        log.debug(`apply agent failed: ${(e as Error).message}`);
      }
    }
    if (this.sessionId && s.model) {
      try {
        await this.acp.setModel(this.sessionId, s.model);
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

  enqueue(input: PromptInput): void {
    this.queue.push(input);
    this.changed();
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
      this.rebindPending = false;
      try {
        await this.acp.loadSession(this.sessionId, this.cwd);
        await this.applySessionPrefs();
        log.info(`chat ${this.chatId} re-bound session ${this.sessionId.slice(0, 8)}`);
        return;
      } catch {
        log.warn(`re-bind failed; new session for chat ${this.chatId}`);
        await this.startNewSession(this.cwd, this.projectName);
        return;
      }
    }
    if (!this.sessionId) await this.startNewSession(this.cwd, this.projectName);
  }

  private async runTurn(input: PromptInput): Promise<void> {
    this.busy = true;
    this.cancelled = false;
    this.shownToolIds = new Set();
    this.streamer = new ResponseStreamer(this.api, this.chatId, this.cfg.streamThrottleMs);
    this.typing.start();
    this.changed();

    const content = buildContentBlocks(input, {
      reasoning: reasoningDirective(this.reasoning),
      priming: this.primingContext,
    });
    this.primingContext = undefined;

    try {
      const result = await this.acp.prompt(this.sessionId!, content);
      await this.streamer.finalize();
      if (this.cancelled || result.stopReason === "cancelled") await this.notify("\u23F9 Stopped.");
      else if (!this.streamer.hasOutput) await this.notify("\u2705 Done (no text output).");
    } catch (err) {
      await this.streamer?.finalize().catch(() => {});
      await this.notify(`\u274C Error: ${(err as Error).message}`);
    } finally {
      this.typing.stop();
      this.streamer = undefined;
      this.busy = false;
      this.changed();
    }

    await this.flushQueue();
  }

  private async flushQueue(): Promise<void> {
    if (this.queue.length === 0 || this.busy) return;
    const batch = mergeInputs(this.queue.splice(0, this.queue.length));
    await this.notify("\u25B6\uFE0F Processing queued message\u2026");
    void this.runTurn(batch);
  }

  private onUpdate(sessionId: string, update: SessionUpdate): void {
    if (!this.busy || sessionId !== this.sessionId || !this.streamer) return;
    const kind = update.sessionUpdate;
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

  private async notify(text: string): Promise<void> {
    try {
      await this.api.sendMessage(this.chatId, text);
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
