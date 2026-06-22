#!/usr/bin/env node
/**
 * Easy setup: creates .env from .env.example, auto-detects the kiro-cli binary
 * and sensible PROJECT_ROOTS, and optionally writes the bot token / user id
 * passed as arguments:
 *
 *   node scripts/setup.mjs <TELEGRAM_BOT_TOKEN> [ALLOWED_USER_ID]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// .env lives in the instance dir (the user's folder); the template ships in the
// package. For a cloned/zip checkout run in place these are the same folder.
const instanceDir = process.env.KIRO_TG_CWD?.trim() || process.cwd();
const envPath = join(instanceDir, ".env");
const examplePath = join(root, ".env.example");

const [, , tokenArg, userArg] = process.argv;

function detectKiro() {
  const candidates = [
    join(homedir(), "AppData", "Local", "Kiro-Cli", "kiro-cli.exe"),
    join(homedir(), ".local", "bin", "kiro-cli"),
    "/usr/local/bin/kiro-cli",
  ];
  return candidates.find((p) => existsSync(p)) || "";
}

function detectRoots() {
  const guesses = ["H:\\Lucru\\Domains", "C:\\Lucru\\Domains", join(homedir(), "projects")];
  return guesses.filter((p) => existsSync(p));
}

let env = existsSync(envPath)
  ? readFileSync(envPath, "utf-8")
  : readFileSync(examplePath, "utf-8");

function setVar(key, value) {
  if (value === undefined || value === "") return;
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
}

const kiro = detectKiro();
if (kiro) {
  setVar("KIRO_CLI_PATH", kiro);
  console.log(`✓ Found kiro-cli: ${kiro}`);
} else {
  console.log("! kiro-cli not auto-detected — set KIRO_CLI_PATH in .env or ensure it's on PATH.");
}

const roots = detectRoots();
if (roots.length) {
  setVar("PROJECT_ROOTS", roots.join(","));
  console.log(`✓ PROJECT_ROOTS: ${roots.join(", ")}`);
}

if (tokenArg) {
  setVar("TELEGRAM_BOT_TOKEN", tokenArg);
  console.log("✓ Wrote TELEGRAM_BOT_TOKEN");
}
if (userArg) {
  setVar("ALLOWED_USERS", userArg);
  console.log(`✓ Wrote ALLOWED_USERS=${userArg}`);
}

writeFileSync(envPath, env, "utf-8");
console.log(`\n✓ .env written to ${envPath}`);

if (!/^TELEGRAM_BOT_TOKEN=.+/m.test(env)) {
  console.log("\nNext: open .env and paste your bot token from @BotFather, then run `kiro-tg run` (or `npm start`).");
} else {
  console.log("\nReady! Run `kiro-tg run` (or `npm start`).");
}
