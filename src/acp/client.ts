/**
 * ACP client — spawns `kiro-cli acp` and speaks JSON-RPC 2.0 over stdio.
 *
 * One process manages many sessions. Callers create/load sessions and send
 * prompts; streamed `session/update` notifications are re-emitted as
 * "session-update" events keyed by sessionId.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createLogger } from "../logger.js";
import { handleServerRequest, type ServerHandlerOptions } from "./server-handlers.js";
import { JsonRpcTransport } from "./transport.js";
import type {
  ContentBlock,
  InitializeResult,
  JsonRpcMessage,
  PermissionOutcome,
  PromptResult,
  RequestPermissionParams,
  SessionNotificationParams,
  SessionUpdate,
} from "./types.js";

const log = createLogger("acp:client");

/** JSON-RPC error codes that usually mean "transient backend hiccup". */
const TRANSIENT_CODES = new Set([-32603, -32500, -32000, 500, 502, 503, 504, 429]);
const TRANSIENT_RE =
  /internal error|high volume|experiencing|overloaded|temporar|unavailable|rate.?limit|too many requests|try again|capacity|\b50[234]\b|\b429\b/i;

/** Error that preserves the agent's JSON-RPC error code and data payload. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

/** Heuristic: is this prompt failure likely transient and safe to retry? */
export function isTransientAcpError(err: Error): boolean {
  const code = (err as AcpError).code;
  if (typeof code === "number" && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_RE.test(err.message);
}

/** Compact, log/Telegram-safe stringification of an error's data payload. */
function shortJson(v: unknown): string {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 300 ? `${s.slice(0, 300)}\u2026` : s;
  } catch {
    return String(v);
  }
}

export interface AcpClientOptions {
  kiroCliPath: string;
  workspace: string;
  trustAllTools: boolean;
  agent?: string;
  requestTimeoutMs?: number;
  autoRestart?: boolean;
  /** Reject a prompt only after this long with no streaming activity. */
  promptIdleTimeoutMs?: number;
  /** Absolute safety cap for a single prompt. */
  promptMaxMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
  method: string;
}

export declare interface AcpClient {
  on(e: "session-update", l: (sessionId: string, update: SessionUpdate) => void): this;
  on(e: "notification", l: (method: string, params: unknown) => void): this;
  on(e: "exit", l: (code: number | null) => void): this;
  on(e: "restarted", l: () => void): this;
  emit(e: "session-update", sessionId: string, update: SessionUpdate): boolean;
  emit(e: "notification", method: string, params: unknown): boolean;
  emit(e: "exit", code: number | null): boolean;
  emit(e: "restarted"): boolean;
}

export class AcpClient extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private transport?: JsonRpcTransport;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private readonly timeout: number;
  private readonly promptIdleMs: number;
  private readonly promptMaxMs: number;
  /** Last time we saw streaming activity for a session (epoch ms). */
  private readonly lastActivity = new Map<string, number>();
  private stopped = false;
  private restartAttempts = 0;
  private restartTimer?: NodeJS.Timeout;
  agentInfo?: { name?: string; version?: string };
  capabilities?: InitializeResult["agentCapabilities"];
  /** Available agent "modes" advertised by Kiro for new sessions. */
  availableModes: Array<{ id: string; name: string; description?: string }> = [];
  currentModeId?: string;
  /** Available models advertised by Kiro (from session/new or session/load). */
  availableModels: Array<{ modelId: string; name: string; description?: string }> = [];
  currentModelId?: string;
  /** Latest metadata per session (context usage %, effort). */
  private readonly metadata = new Map<string, { contextUsagePercentage?: number; effort?: string }>();
  /** Optional handler for tool permission requests (set by the bot layer). */
  permissionHandler?: (params: RequestPermissionParams) => Promise<PermissionOutcome>;

  constructor(private readonly opts: AcpClientOptions) {
    super();
    this.setMaxListeners(0); // one session-update listener per chat runtime
    this.timeout = opts.requestTimeoutMs ?? 120_000;
    this.promptIdleMs = opts.promptIdleTimeoutMs ?? 900_000; // 15 min with no activity
    this.promptMaxMs = opts.promptMaxMs ?? 6 * 60 * 60_000; // 6 h hard cap
  }

  /** Spawn the process and run the ACP initialize handshake. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const args = ["acp"];
    if (this.opts.trustAllTools) args.push("--trust-all-tools");
    if (this.opts.agent) args.push("--agent", this.opts.agent);

    log.info(`spawning: ${this.opts.kiroCliPath} ${args.join(" ")}`);
    this.proc = spawn(this.opts.kiroCliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.workspace,
      env: { ...process.env, KIRO_LOG_LEVEL: process.env.KIRO_LOG_LEVEL || "error" },
    }) as ChildProcessWithoutNullStreams;

    this.proc.on("exit", (code) => {
      log.warn(`kiro-cli acp exited (code ${code})`);
      this.failAllPending(new Error(`kiro-cli acp exited (code ${code})`));
      this.emit("exit", code);
      this.maybeRestart();
    });
    this.proc.on("error", (err) => {
      log.error("failed to spawn kiro-cli:", err.message);
      this.failAllPending(err);
    });

    this.transport = new JsonRpcTransport(this.proc);
    this.transport.on("message", (m: JsonRpcMessage) => this.onMessage(m));

    const init = (await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "kiro-telegram-bot", version: "1.0.0" },
    })) as InitializeResult;

    this.agentInfo = init.agentInfo;
    this.capabilities = init.agentCapabilities;
    this.restartAttempts = 0;
    log.info(`connected: ${init.agentInfo?.name ?? "kiro"} ${init.agentInfo?.version ?? ""}`.trim());
  }

  /** Restart the agent with exponential backoff after an unexpected exit. */
  private maybeRestart(): void {
    if (this.stopped || !this.opts.autoRestart) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.restartAttempts);
    this.restartAttempts += 1;
    log.warn(`auto-restarting ACP in ${delay}ms (attempt ${this.restartAttempts})`);
    this.restartTimer = setTimeout(() => {
      this.connect()
        .then(() => {
          log.info("ACP reconnected");
          this.emit("restarted");
        })
        .catch((e) => {
          log.error("ACP restart failed:", (e as Error).message);
          this.maybeRestart();
        });
    }, delay);
  }

  get supportsLoadSession(): boolean {
    return Boolean(this.capabilities?.loadSession);
  }

  /** PID of the bot's own kiro-cli acp process (to avoid killing ourselves). */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async newSession(cwd: string): Promise<string> {
    const res = (await this.request("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
    this.parseSessionExtras(res);
    return res.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    const res = await this.request("session/load", { sessionId, cwd, mcpServers: [] });
    this.parseSessionExtras(res);
  }

  hasMode(id: string): boolean {
    return this.availableModes.some((m) => m.id === id);
  }

  hasModel(id: string): boolean {
    return id === "auto" || this.availableModels.some((m) => m.modelId === id);
  }

  /** Capture available modes (agents) and models from a session response. */
  private parseSessionExtras(result: unknown): void {
    const r = result as {
      modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string; description?: string }> };
      models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string; description?: string }> };
    };
    if (r?.modes?.availableModes?.length) this.availableModes = r.modes.availableModes;
    if (r?.modes?.currentModeId) this.currentModeId = r.modes.currentModeId;
    if (r?.models?.availableModels?.length) this.availableModels = r.models.availableModels;
    if (r?.models?.currentModelId) this.currentModelId = r.models.currentModelId;
  }

  /**
   * Send a prompt. Resolves when the turn ends. Instead of a fixed timeout
   * (which kills long turns), this rejects only after `promptIdleMs` with no
   * streaming activity, or after the absolute `promptMaxMs` cap.
   *
   * Transient-error auto-retry (with backoff and user feedback) is orchestrated
   * one level up in the bot runtime — see `SessionRuntime.runPromptWithRetries`.
   */
  prompt(sessionId: string, content: ContentBlock[]): Promise<PromptResult> {
    return new Promise<PromptResult>((resolve, reject) => {
      const id = this.nextId++;
      const start = Date.now();
      this.lastActivity.set(sessionId, start);
      const watch = setInterval(() => {
        const idle = Date.now() - (this.lastActivity.get(sessionId) ?? start);
        const total = Date.now() - start;
        if (total > this.promptMaxMs) {
          this.pending.delete(id);
          clearInterval(watch);
          reject(new Error(`Prompt exceeded the ${Math.round(this.promptMaxMs / 60_000)}min cap`));
        } else if (idle > this.promptIdleMs) {
          this.pending.delete(id);
          clearInterval(watch);
          reject(new Error(`No agent activity for ${Math.round(idle / 1000)}s — giving up`));
        }
      }, 15_000);
      this.pending.set(id, {
        resolve: (v) => resolve(v as PromptResult),
        reject,
        cleanup: () => clearInterval(watch),
        method: "session/prompt",
      });
      try {
        this.transport!.send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: content } });
      } catch (e) {
        clearInterval(watch);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      // session/cancel is a notification in ACP.
      this.transport?.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    } catch (e) {
      log.debug("cancel failed:", (e as Error).message);
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request("session/set_model", { sessionId, modelId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request("session/set_mode", { sessionId, modeId });
    this.currentModeId = modeId;
  }

  /** Execute a Kiro slash command via the _kiro.dev extension. */
  async executeCommand(sessionId: string, command: string): Promise<unknown> {
    return this.request("_kiro.dev/commands/execute", { sessionId, command });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.proc?.kill();
    this.proc = undefined;
  }

  /** Manually restart the agent (used by the /restart command). */
  async restart(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.proc?.kill();
    this.proc = undefined;
    this.stopped = false;
    await this.connect();
    this.emit("restarted");
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${this.timeout}ms: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, cleanup: () => clearTimeout(timer), method });
      try {
        this.transport!.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Build a rich Error from a JSON-RPC error object, and log it. */
  private toAcpError(error: { code: number; message: string; data?: unknown }, method: string): AcpError {
    const codeStr = typeof error.code === "number" ? ` [${error.code}]` : "";
    const detail = error.data === undefined ? "" : ` — ${shortJson(error.data)}`;
    const text = `${error.message || "ACP error"}${codeStr}${detail}`;
    log.warn(`${method} failed: ${text}`);
    return new AcpError(text, error.code, error.data);
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id) && msg.method === undefined) {
      const p = this.pending.get(msg.id)!;
      p.cleanup();
      this.pending.delete(msg.id);
      if (msg.error) p.reject(this.toAcpError(msg.error, p.method));
      else p.resolve(msg.result);
      return;
    }

    // Request from the agent (has both id and method) — needs a response.
    if (msg.id !== undefined && msg.id !== null && msg.method) {
      void this.respondToServerRequest(msg.id, msg.method, (msg.params as Record<string, unknown>) || {});
      return;
    }

    // Notification (method, no id).
    if (msg.method) {
      this.routeNotification(msg.method, msg.params);
    }
  }

  private async respondToServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const handlerOpts: ServerHandlerOptions = {
      workspace: this.opts.workspace,
      trustAllTools: this.opts.trustAllTools,
    };
    try {
      let result: unknown;
      if (method === "session/request_permission" && this.permissionHandler) {
        result = await this.permissionHandler(params as unknown as RequestPermissionParams);
      } else {
        result = await handleServerRequest(method, params, handlerOpts);
      }
      this.transport?.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.transport?.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: (err as Error).message },
      });
    }
  }

  private routeNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      const p = params as SessionNotificationParams;
      if (p?.sessionId && p.update) {
        this.lastActivity.set(p.sessionId, Date.now()); // keeps long, active turns alive
        this.emit("session-update", p.sessionId, p.update);
        return;
      }
    }
    if (method === "_kiro.dev/metadata") {
      const p = params as { sessionId?: string; contextUsagePercentage?: number; effort?: string };
      if (p?.sessionId) {
        this.metadata.set(p.sessionId, {
          contextUsagePercentage: p.contextUsagePercentage,
          effort: p.effort,
        });
      }
    }
    this.emit("notification", method, params);
  }

  /** Latest context-usage % / effort reported for a session. */
  metadataFor(sessionId: string | undefined): { contextUsagePercentage?: number; effort?: string } | undefined {
    return sessionId ? this.metadata.get(sessionId) : undefined;
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.cleanup();
      p.reject(err);
    }
    this.pending.clear();
  }
}
