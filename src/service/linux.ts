/**
 * Linux service controller — installs a systemd *user* service so no sudo is
 * required. `loginctl enable-linger` is attempted so the bot runs at boot even
 * before you log in.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { runSafe } from "./platform.js";
import type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

const UNIT = "kiro-telegram-bot.service";

function unitPath(): string {
  return join(homedir(), ".config", "systemd", "user", UNIT);
}

export const linuxController: ServiceController = {
  platform: "linux",

  async install(spec) {
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    mkdirSync(spec.logsDir, { recursive: true });
    writeFileSync(unitPath(), unitFile(spec), "utf-8");

    runSafe("systemctl", ["--user", "daemon-reload"]);
    const en = runSafe("systemctl", ["--user", "enable", "--now", UNIT]);
    if (!en.ok) return fail(`systemctl enable failed: ${en.out}`);
    const linger = runSafe("loginctl", ["enable-linger", userInfo().username]);
    const note = linger.ok ? " Boot-without-login enabled (linger)." : " (run `loginctl enable-linger` for boot-without-login)";
    return ok(`Installed and started systemd user service "${UNIT}".${note}`);
  },

  async uninstall() {
    runSafe("systemctl", ["--user", "disable", "--now", UNIT]);
    rmSync(unitPath(), { force: true });
    runSafe("systemctl", ["--user", "daemon-reload"]);
    return ok(`Removed systemd user service "${UNIT}".`);
  },

  async start() {
    const r = runSafe("systemctl", ["--user", "start", UNIT]);
    return r.ok ? ok("Started.") : fail(r.out);
  },

  async stop() {
    const r = runSafe("systemctl", ["--user", "stop", UNIT]);
    return r.ok ? ok("Stopped.") : fail(r.out);
  },

  async status() {
    const r = runSafe("systemctl", ["--user", "status", UNIT, "--no-pager"]);
    return ok(r.out.trim() || "No status.");
  },
};

function unitFile(spec: LaunchSpec): string {
  const exec = `${spec.nodePath} ${spec.args.join(" ")}`;
  const env = Object.entries(spec.env ?? {}).map(([k, v]) => `Environment=${k}=${v}`);
  return [
    "[Unit]",
    `Description=${spec.displayName}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${spec.cwd}`,
    ...env,
    `ExecStart=${exec}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function ok(message: string): ServiceResult {
  return { ok: true, message };
}
function fail(message: string): ServiceResult {
  return { ok: false, message };
}
