/**
 * Auto-updater — once an hour, asks npm for the latest published version with a
 * single lightweight request. When a newer version exists AND the bot is fully
 * idle (no in-flight prompt, no other active Kiro session on the PC), it
 * announces in chat, runs `npm install -g kiro-telegram-bot@<latest>`, and
 * restarts to apply. After the restart it posts the new version's CHANGELOG
 * (tagged #update) so every release is easy to find in the conversation.
 *
 * Safety:
 *   • only ever updates when idle — never interrupts a running turn/task;
 *   • only for a global npm install (a cloned/source checkout is left alone);
 *   • restart is supervisor-aware: under systemd/launchd it exits cleanly and
 *     lets the supervisor relaunch; on Windows / foreground it re-execs itself.
 */
import { spawn } from "node:child_process";
import { get } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonStore } from "./json-store.js";
import { createLogger } from "../logger.js";
import { extractChangelog, isNewer, isSafeVersion } from "./version.js";

const log = createLogger("updater");
const PKG = "kiro-telegram-bot";

interface PendingUpdate {
  from: string;
  to: string;
  chats: number[];
}

export interface UpdaterOptions {
  enabled: boolean;
  intervalMs: number;
  projectRoot: string;
  instanceDir: string;
  dataDir: string;
  /** True while the agent is busy (a chat turn or scheduled task). */
  isPromptInFlight: () => boolean;
  /** Active Kiro sessions on this PC NOT owned by the bot's own agent. */
  otherActiveSessions: () => number;
  /** Send a plain or markdown message to every chat. */
  announce: (text: string, markdown: boolean) => Promise<void>;
  /** Stop polling + the agent before the process exits/re-execs. */
  shutdown: () => Promise<void>;
}

export class Updater {
  private timer: NodeJS.Timeout | undefined;
  private readonly state: JsonStore<PendingUpdate | null>;
  private readonly current: string;
  private attempting = false;
  private readonly tried = new Set<string>();

  constructor(private readonly opts: UpdaterOptions) {
    this.state = new JsonStore<PendingUpdate | null>(join(opts.dataDir, "update-state.json"), null);
    this.current = readVersion(opts.projectRoot);
  }

  /** Announce a just-applied update (if any), then begin hourly checks. */
  async start(): Promise<void> {
    await this.announcePending();
    if (!this.opts.enabled) {
      log.info("auto-update disabled (AUTO_UPDATE=false)");
      return;
    }
    if (!this.isNpmInstall()) {
      log.info("running from source — auto-update is a no-op (use git to update)");
      return;
    }
    // First check shortly after boot, then on the configured interval.
    this.timer = setTimeout(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.tick(), this.opts.intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      await this.checkAndUpdate();
    } catch (e) {
      log.debug("update check failed:", (e as Error).message);
    } finally {
      this.schedule();
    }
  }

  private async checkAndUpdate(): Promise<void> {
    if (this.attempting) return;
    const latest = await fetchLatestVersion();
    if (!latest || !isSafeVersion(latest)) return;
    if (!isNewer(latest, this.current)) return;
    if (this.tried.has(latest)) return; // don't loop on a version we already tried

    if (this.opts.isPromptInFlight() || this.opts.otherActiveSessions() > 0) {
      log.info(`update ${this.current} -> ${latest} available; waiting for idle`);
      return; // re-evaluated next interval
    }
    await this.applyUpdate(latest);
  }

  private async applyUpdate(latest: string): Promise<void> {
    this.attempting = true;
    this.tried.add(latest);
    log.info(`updating ${this.current} -> ${latest}`);
    await this.opts.announce(
      `\u{1F504} #update Updating ${PKG} v${this.current} \u2192 v${latest}\u2026\nThe bot is idle, so it's safe \u2014 it will restart and report what changed.`,
      false,
    );

    const ok = await npmInstall(latest);
    if (!ok) {
      this.attempting = false;
      await this.opts.announce(
        `\u26A0\uFE0F #update Update to v${latest} failed (\`npm install -g\`). I'll try again after the next restart.`,
        false,
      );
      return;
    }

    this.state.set({ from: this.current, to: latest, chats: this.announceChats() });
    await this.restart();
  }

  /** After a restart, post the new version's changelog (once), tagged #update. */
  private async announcePending(): Promise<void> {
    const pending = this.state.get();
    if (!pending) return;
    this.state.set(null); // consume regardless, so we never re-announce
    if (pending.to !== this.current) {
      log.warn(`pending update to ${pending.to} but running ${this.current}; skipping announce`);
      return;
    }
    const notes = this.changelogFor(pending.to);
    const body = notes
      ? `\u{1F680} #update Updated v${pending.from} \u2192 **v${pending.to}**\n\n${notes}`
      : `\u{1F680} #update Updated to **v${pending.to}**.`;
    await this.opts.announce(body, true);
  }

  private async restart(): Promise<void> {
    await this.opts.shutdown().catch(() => {});
    // Under systemd/launchd, a clean exit triggers a managed relaunch (no double
    // instance). On Windows / foreground there is no supervisor, so re-exec.
    if (process.env.KIRO_TG_SUPERVISED === "1") {
      log.info("exiting for supervisor to relaunch the updated bot");
      setTimeout(() => process.exit(0), 250);
      return;
    }
    log.info("re-executing the updated bot");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(this.opts.projectRoot, "src", "index.ts"), "--instance", this.opts.instanceDir],
      { detached: true, stdio: "ignore", cwd: this.opts.projectRoot, env: process.env },
    );
    child.unref();
    setTimeout(() => process.exit(0), 500);
  }

  private isNpmInstall(): boolean {
    return this.opts.projectRoot.replace(/\\/g, "/").includes("/node_modules/");
  }

  private announceChats(): number[] {
    const pending = this.state.get();
    return pending?.chats ?? [];
  }

  private changelogFor(version: string): string {
    try {
      const md = readFileSync(join(this.opts.projectRoot, "CHANGELOG.md"), "utf-8");
      return extractChangelog(md, version);
    } catch {
      return "";
    }
  }
}

/** Read the installed version from package.json (falls back to "0.0.0"). */
function readVersion(projectRoot: string): string {
  try {
    return (JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** One small HTTPS GET to the npm registry's dist-tag manifest for `latest`. */
function fetchLatestVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = get(
      `https://registry.npmjs.org/${PKG}/latest`,
      { timeout: 10_000, headers: { Accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(undefined);
          return;
        }
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve((JSON.parse(body) as { version?: string }).version);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/** Run `npm install -g kiro-telegram-bot@<version>`; resolves true on success. */
function npmInstall(version: string): Promise<boolean> {
  return new Promise((resolve) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(npm, ["install", "-g", `${PKG}@${version}`], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
