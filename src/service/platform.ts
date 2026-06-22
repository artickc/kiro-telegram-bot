/**
 * Platform detection, launch-spec construction, and a small command runner
 * shared by the per-OS service controllers.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PROJECT_ROOT, INSTANCE_DIR } from "../config.js";

export type Platform = "windows" | "linux" | "macos" | "unknown";

export function detectPlatform(): Platform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    case "darwin":
      return "macos";
    default:
      return "unknown";
  }
}

import type { LaunchSpec } from "./types.js";

/** Build the launch spec that runs the bot via the current node + tsx loader. */
export function buildLaunchSpec(): LaunchSpec {
  const logsDir = join(INSTANCE_DIR, "logs");
  const args = ["--import", "tsx", join(PROJECT_ROOT, "src", "index.ts")];
  // Run the code from the package dir (cwd below) so `tsx` resolves, but tell
  // the bot where its .env/logs/data live. Only appended for a global install
  // (instance dir differs) so in-place checkouts keep identical launch args.
  if (INSTANCE_DIR !== PROJECT_ROOT) args.push("--instance", INSTANCE_DIR);
  return {
    id: "kiro-telegram-bot",
    displayName: "Kiro Telegram Bot",
    nodePath: process.execPath,
    args,
    cwd: PROJECT_ROOT,
    logsDir,
    logFile: join(logsDir, "kiro-telegram-bot.log"),
  };
}

/** Run a command, returning combined output. Throws on non-zero exit. */
export function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Run a command, swallowing errors and returning { ok, out }. */
export function runSafe(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args) };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const out = String(err.stdout ?? "") + String(err.stderr ?? "") || err.message || "failed";
    return { ok: false, out };
  }
}
