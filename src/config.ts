/**
 * Configuration: loads .env, validates required values, resolves paths.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the installed bot code (one level above src/). For a global
 *  npm install this lives inside node_modules — code lives here, never user data. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical, path-independent home for this bot's `.env`, `logs/`, `data/` and
 *  the single-instance locks: `~/.kiro/tg`. Used whenever the bot is started
 *  without an explicit instance dir and there's no `.env` in the current folder,
 *  so the SAME configuration is found no matter which directory you launch from. */
export const CANONICAL_DIR = join(homedir(), ".kiro", "tg");

/**
 * Directory holding THIS instance's `.env`, `logs/` and `data/`. Resolution
 * (first match wins):
 *   1. `--instance <dir>` argv — set by the installed background service,
 *   2. `KIRO_TG_DIR` env — an explicit override,
 *   3. `KIRO_TG_CWD` env — the legacy launcher variable,
 *   4. the current folder, IF it already contains a `.env` (an explicit
 *      per-folder bot — keeps cloned/zip checkouts working in place),
 *   5. the canonical `~/.kiro/tg` home — the path-independent default, so a
 *      `.env` created once is loaded no matter where the bot is started from.
 */
export const INSTANCE_DIR = resolveInstanceDir();

/** Absolute path to the `.env` this instance loads (and that `setup` writes). */
export const ENV_PATH = join(INSTANCE_DIR, ".env");

function resolveInstanceDir(): string {
  const flag = process.argv.indexOf("--instance");
  if (flag !== -1 && process.argv[flag + 1]) return resolve(process.argv[flag + 1]!);
  const envDir = process.env.KIRO_TG_DIR?.trim() || process.env.KIRO_TG_CWD?.trim();
  if (envDir) return resolve(expandHome(envDir));
  if (existsSync(join(process.cwd(), ".env"))) return process.cwd();
  return CANONICAL_DIR;
}

// Load .env from the resolved instance directory. dotenv does NOT override
// variables already present in the environment (the launcher/service env wins).
loadDotenv({ path: ENV_PATH });

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Like num() but allows 0 (e.g. to disable retries). Rejects negatives. */
function nonNegNum(v: string | undefined, def: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function list(v: string | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface AppConfig {
  token: string;
  allowedUsers: Set<string>;
  kiroCliPath: string;
  workspace: string;
  agent?: string;
  trustAllTools: boolean;
  projectRoots: string[];
  streamThrottleMs: number;
  /** Debounce window (ms) for coalescing rapid consecutive text messages
   *  (e.g. a long message Telegram split at 4096 chars) into one prompt. */
  messageBatchMs: number;
  showToolCalls: boolean;
  showEditDiffs: boolean;
  diffMaxLines: number;
  sendAgentImages: boolean;
  agentImagesMax: number;
  logLevel: string;
  sessionsDir: string;
  projectRoot: string;
  logsDir: string;
  logFile: string;
  acpAutoRestart: boolean;
  dataDir: string;
  promptIdleMs: number;
  quietNotifications: boolean;
  promptRetryAttempts: number;
  /** After transient prompt errors are exhausted, fork the session into a fresh
   *  primed continuation and retry once (recovers throttled/exhausted/stuck
   *  sessions automatically). */
  autoForkOnError: boolean;
  /** When a prompt fails transiently and this session's last-known context
   *  usage is at/above this percentage (0 disables), skip the retry backoff and
   *  auto-fork immediately — a context-exhausted session won't recover by
   *  retrying the same oversized prompt. Requires `autoForkOnError`. */
  autoForkContextPct: number;
  sttApiUrl?: string;
  sttApiKey?: string;
  sttModel: string;
  sttLanguage?: string;
  /** Per-server timeout for the /mcp live health probe. */
  mcpProbeTimeoutMs: number;
  /** How many MCP health probes run concurrently. */
  mcpProbeConcurrency: number;
  /** Show subagent (crew) activity while the main agent waits on them. */
  showSubagents: boolean;
  /** Ask the agent to emit a `{progress: N%}` marker and render it as a bar. */
  showProgress: boolean;
  /** When the agent emits no `{progress}` marker, show a bot-computed fallback
   *  bar derived from real activity (tool calls, streamed output, elapsed). */
  progressFallback: boolean;
  /** Deliver a turn's "Done" summary to the chat even when that session is in
   *  the background (you've switched to another session). */
  notifyOtherSessions: boolean;
  /** Check npm hourly and auto-update when idle (announces in chat). */
  autoUpdate: boolean;
  /** How often to check npm for a newer version (ms). */
  updateCheckMs: number;
  /** Enforce a single running instance per bot token: on startup, a still-alive
   *  ghost/duplicate holding the lock is terminated so the fresh process (with
   *  the current `.env`) is the only Telegram getUpdates consumer. */
  singleInstance: boolean;
}

export function loadConfig(): AppConfig {
  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and set it (run `npm run setup`).",
    );
  }

  const workspaceRaw = process.env.KIRO_WORKSPACE?.trim() || process.cwd();
  const workspace = resolve(expandHome(workspaceRaw));

  // Default project roots: the workspace parent + home directory.
  const roots = list(process.env.PROJECT_ROOTS).map((p) => resolve(expandHome(p)));
  if (roots.length === 0) {
    roots.push(dirname(workspace), homedir());
  }

  const sessionsDir = join(homedir(), ".kiro", "sessions", "cli");
  const logsDir = process.env.LOG_DIR?.trim()
    ? resolve(expandHome(process.env.LOG_DIR.trim()))
    : join(INSTANCE_DIR, "logs");
  const logFile = process.env.LOG_FILE?.trim()
    ? resolve(expandHome(process.env.LOG_FILE.trim()))
    : join(logsDir, "kiro-telegram-bot.log");

  const cfg: AppConfig = {
    token,
    allowedUsers: new Set(list(process.env.ALLOWED_USERS)),
    kiroCliPath: resolveKiroPath(process.env.KIRO_CLI_PATH?.trim()),
    workspace,
    agent: process.env.KIRO_AGENT?.trim() || undefined,
    trustAllTools: bool(process.env.KIRO_TRUST_ALL_TOOLS, true),
    projectRoots: [...new Set(roots)],
    streamThrottleMs: num(process.env.STREAM_THROTTLE_MS, 1500),
    messageBatchMs: nonNegNum(process.env.MESSAGE_BATCH_MS, 800),
    showToolCalls: bool(process.env.SHOW_TOOL_CALLS, true),
    showEditDiffs: bool(process.env.SHOW_EDIT_DIFFS, true),
    diffMaxLines: num(process.env.DIFF_MAX_LINES, 120),
    sendAgentImages: bool(process.env.SEND_AGENT_IMAGES, true),
    agentImagesMax: num(process.env.AGENT_IMAGES_MAX, 8),
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    sessionsDir,
    projectRoot: PROJECT_ROOT,
    logsDir,
    logFile,
    acpAutoRestart: bool(process.env.ACP_AUTO_RESTART, true),
    promptIdleMs: num(process.env.PROMPT_IDLE_TIMEOUT_MS, 900_000),
    quietNotifications: bool(process.env.QUIET_NOTIFICATIONS, true),
    promptRetryAttempts: nonNegNum(process.env.PROMPT_RETRY_ATTEMPTS, 5),
    autoForkOnError: bool(process.env.AUTO_FORK_ON_ERROR, true),
    autoForkContextPct: nonNegNum(process.env.AUTO_FORK_CONTEXT_PCT, 85),
    dataDir: process.env.DATA_DIR?.trim()
      ? resolve(expandHome(process.env.DATA_DIR.trim()))
      : join(INSTANCE_DIR, "data"),
    sttApiUrl: process.env.STT_API_URL?.trim() || undefined,
    sttApiKey: process.env.STT_API_KEY?.trim() || undefined,
    sttModel: process.env.STT_MODEL?.trim() || "whisper-1",
    sttLanguage: process.env.STT_LANGUAGE?.trim() || undefined,
    mcpProbeTimeoutMs: num(process.env.MCP_PROBE_TIMEOUT_MS, 8000),
    mcpProbeConcurrency: num(process.env.MCP_PROBE_CONCURRENCY, 6),
    showSubagents: bool(process.env.SHOW_SUBAGENTS, true),
    showProgress: bool(process.env.SHOW_PROGRESS, true),
    progressFallback: bool(process.env.PROGRESS_FALLBACK, true),
    notifyOtherSessions: bool(process.env.NOTIFY_OTHER_SESSIONS, true),
    autoUpdate: bool(process.env.AUTO_UPDATE, true),
    updateCheckMs: num(process.env.UPDATE_CHECK_MS, 3_600_000),
    singleInstance: bool(process.env.KIRO_TG_SINGLE_INSTANCE, true),
  };

  return cfg;
}

/** Resolve the kiro-cli binary path, trying common Windows install dirs. */
function resolveKiroPath(explicit?: string): string {
  if (explicit) return expandHome(explicit);

  const candidates = [
    join(homedir(), "AppData", "Local", "Kiro-Cli", "kiro-cli.exe"),
    join(homedir(), ".local", "bin", "kiro-cli"),
    "/usr/local/bin/kiro-cli",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to PATH lookup.
  return "kiro-cli";
}

export function isAbsolutePath(p: string): boolean {
  return isAbsolute(p);
}
