/**
 * macOS service controller — installs a launchd LaunchAgent that runs at login
 * and is kept alive automatically.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runSafe } from "./platform.js";
import type { LaunchSpec, ServiceController, ServiceResult } from "./types.js";

const LABEL = "com.kiro.telegrambot";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

export const macosController: ServiceController = {
  platform: "macos",

  async install(spec) {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(spec.logsDir, { recursive: true });
    const path = plistPath();
    runSafe("launchctl", ["unload", "-w", path]); // ignore if not loaded
    writeFileSync(path, plist(spec), "utf-8");
    const r = runSafe("launchctl", ["load", "-w", path]);
    return r.ok ? ok(`Installed and loaded LaunchAgent "${LABEL}".`) : fail(r.out);
  },

  async uninstall() {
    runSafe("launchctl", ["unload", "-w", plistPath()]);
    rmSync(plistPath(), { force: true });
    return ok(`Removed LaunchAgent "${LABEL}".`);
  },

  async start() {
    const r = runSafe("launchctl", ["start", LABEL]);
    return r.ok ? ok("Started.") : fail(r.out);
  },

  async stop() {
    const r = runSafe("launchctl", ["stop", LABEL]);
    return r.ok ? ok("Stopped.") : fail(r.out);
  },

  async status() {
    const r = runSafe("launchctl", ["list"]);
    const line = r.out.split("\n").find((l) => l.includes(LABEL));
    return ok(line ? `Loaded: ${line.trim()}` : "Not loaded.");
  },
};

function plist(spec: LaunchSpec): string {
  const args = [spec.nodePath, ...spec.args].map((a) => `    <string>${esc(a)}</string>`).join("\n");
  const envEntries = Object.entries(spec.env ?? {});
  const envBlock = envEntries.length
    ? [
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...envEntries.flatMap(([k, v]) => [`    <key>${esc(k)}</key>`, `    <string>${esc(v)}</string>`]),
        "  </dict>",
      ]
    : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    args,
    "  </array>",
    ...envBlock,
    "  <key>WorkingDirectory</key>",
    `  <string>${esc(spec.cwd)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${esc(spec.logFile)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${esc(spec.logFile)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ok(message: string): ServiceResult {
  return { ok: true, message };
}
function fail(message: string): ServiceResult {
  return { ok: false, message };
}
