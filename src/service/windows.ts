/**
 * Windows service controller — runs the bot at logon via a hidden Scheduled
 * Task. A small .vbs launcher starts node with no console window; the app logs
 * to a file. Stop precisely targets our node process by command line.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSafe } from "./platform.js";
import type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

const TASK = "KiroTelegramBot";

export const windowsController: ServiceController = {
  platform: "windows",

  async install(spec) {
    mkdirSync(spec.logsDir, { recursive: true });
    const vbs = join(spec.cwd, "run-service.vbs");
    writeFileSync(vbs, vbsLauncher(spec), "utf-8");

    runSafe("schtasks", ["/Delete", "/F", "/TN", TASK]); // replace if present
    const res = runSafe("schtasks", [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      TASK,
      "/TR",
      `wscript.exe "${vbs}"`,
    ]);
    if (!res.ok) return fail(`schtasks create failed: ${res.out}`);
    runSafe("schtasks", ["/Run", "/TN", TASK]);
    return ok(`Installed scheduled task "${TASK}" (starts at logon) and launched it.`);
  },

  async uninstall(spec) {
    await this.stop(spec);
    const res = runSafe("schtasks", ["/Delete", "/F", "/TN", TASK]);
    rmSync(join(spec.cwd, "run-service.vbs"), { force: true });
    return res.ok ? ok(`Removed scheduled task "${TASK}".`) : fail(res.out);
  },

  async start() {
    const res = runSafe("schtasks", ["/Run", "/TN", TASK]);
    return res.ok ? ok("Started.") : fail(res.out);
  },

  async stop(spec) {
    runSafe("schtasks", ["/End", "/TN", TASK]);
    const res = runSafe("powershell", ["-NoProfile", "-Command", killScript(entryOf(spec))]);
    return ok(`Stopped. ${res.out.trim()}`);
  },

  async status(spec) {
    const task = runSafe("schtasks", ["/Query", "/TN", TASK, "/FO", "LIST"]);
    const proc = runSafe("powershell", ["-NoProfile", "-Command", countScript(entryOf(spec))]);
    const running = proc.ok && /[1-9]\d*/.test(proc.out.trim());
    const installed = task.ok;
    return ok(
      `Installed: ${installed ? "yes" : "no"} | Running: ${running ? "yes" : "no"}\n` +
        (installed ? task.out.trim() : "Task not found."),
    );
  },
};

/** The bot entry file — unique enough to identify the bot process. It may be
 *  followed by trailing args (e.g. `--instance <dir>`), so find it explicitly. */
function entryOf(spec: LaunchSpec): string {
  return (
    spec.args.find((a) => a.endsWith("index.ts")) ?? spec.args[spec.args.length - 1] ?? spec.cwd
  );
}

function vbsLauncher(spec: LaunchSpec): string {
  const cmd = `""${spec.nodePath}"" ${spec.args.map((a) => `""${a}""`).join(" ")}`;
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${spec.cwd}"`,
    `sh.Run "${cmd}", 0, False`,
  ].join("\r\n");
}

function killScript(entry: string): string {
  const safe = entry.replace(/'/g, "''");
  return [
    `$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${safe}*' };`,
    `$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };`,
    `"killed " + (@($p).Count)`,
  ].join(" ");
}

function countScript(entry: string): string {
  const safe = entry.replace(/'/g, "''");
  return `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${safe}*' }).Count`;
}

function ok(message: string): ServiceResult {
  return { ok: true, message };
}
function fail(message: string): ServiceResult {
  return { ok: false, message };
}
