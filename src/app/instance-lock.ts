/**
 * Single-instance guard, keyed per bot token (NOT per folder), so the same bot
 * can't run twice no matter which directory it's started from.
 *
 * Telegram allows only ONE long-polling consumer per token — a second instance
 * triggers 409 Conflict and, worse, a leftover "ghost" process started from an
 * old folder keeps answering with a stale `.env` (e.g. an outdated
 * `ALLOWED_USERS`, so you get "⛔ Not authorized"). On startup we therefore
 * take an exclusive lock: if a still-alive instance holds it, we terminate that
 * process (and its child tree on Windows) so the fresh process — with the
 * current config — becomes the only consumer.
 *
 * The lock lives under the canonical home (`~/.kiro/tg/locks/<tokenHash>.lock`)
 * and stores only a pid + start time + whether the holder is supervised. The
 * token itself is never written to disk (only its hash names the file).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { killPid } from "../sessions/process.js";
import { isPidAlive } from "../sessions/store.js";

const log = createLogger("lock");

interface LockData {
  pid: number;
  startedAt: number;
  /** True when the holder runs under a supervisor (systemd/launchd/Task). */
  supervised: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class InstanceLock {
  private readonly file: string;
  private held = false;

  constructor(
    token: string,
    locksDir: string,
    private readonly supervised: boolean,
  ) {
    const hash = createHash("sha256").update(token).digest("hex").slice(0, 16);
    this.file = join(locksDir, `${hash}.lock`);
  }

  /**
   * Become the sole instance for this token. Returns `false` (caller should
   * exit) only when a *supervised* service instance is already running and this
   * process is a plain manual start — we don't fight the background service
   * (that would cause a restart/kill loop). Otherwise we take over: a live
   * holder is terminated and the lock is rewritten with our pid.
   */
  async acquire(): Promise<boolean> {
    const existing = this.read();
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      if (existing.supervised && !this.supervised) {
        log.warn(`a supervised service instance is already running (pid ${existing.pid}); not starting a duplicate`);
        return false;
      }
      if (looksLikeNode(existing.pid)) {
        log.warn(`another bot instance is running (pid ${existing.pid}); terminating it to take over`);
        killPid(existing.pid);
        for (let i = 0; i < 20 && isPidAlive(existing.pid); i++) await sleep(150); // up to ~3s
        if (isPidAlive(existing.pid)) log.warn(`previous instance ${existing.pid} still alive after kill; continuing anyway`);
      } else {
        // The locked pid was recycled to an unrelated process — don't kill it,
        // just reclaim the stale lock.
        log.warn(`lock pid ${existing.pid} is not a node process; reclaiming stale lock`);
      }
    }
    this.write();
    this.held = true;
    return true;
  }

  /** Release the lock if (and only if) we still own it. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const cur = this.read();
      if (cur?.pid === process.pid) rmSync(this.file, { force: true });
    } catch {
      /* best-effort */
    }
  }

  private write(): void {
    const data: LockData = { pid: process.pid, startedAt: Date.now(), supervised: this.supervised };
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data), "utf-8");
    } catch (e) {
      log.warn(`could not write lock file ${this.file}: ${(e as Error).message}`);
    }
  }

  private read(): LockData | undefined {
    try {
      const d = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<LockData>;
      if (typeof d.pid === "number" && d.pid > 0) {
        return { pid: d.pid, startedAt: Number(d.startedAt) || 0, supervised: Boolean(d.supervised) };
      }
    } catch {
      /* no/invalid lock */
    }
    return undefined;
  }
}

/**
 * Best-effort check that `pid` is a node process (our bot), to avoid killing an
 * unrelated process that happened to reuse the pid. If the platform query can't
 * run or be parsed, we assume it's ours (only this bot writes the lock) — better
 * to clear a ghost than to leave one fighting over the token.
 */
function looksLikeNode(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      // No matching task prints an INFO line, not a CSV row — treat as "gone".
      if (!/^\s*"/.test(out)) return false;
      return /node\.exe|tsx/i.test(out);
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /node|tsx/i.test(out);
  } catch {
    return true;
  }
}
