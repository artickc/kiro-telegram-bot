/**
 * MCP config store — reads and edits Kiro's `mcp.json` files.
 *
 * Sources, in precedence order for display (a workspace entry shadows a global
 * one with the same name, mirroring how Kiro merges them):
 *   • global    → `~/.kiro/settings/mcp.json`
 *   • workspace → `<cwd>/.kiro/settings/mcp.json`
 *
 * Edits are surgical: we parse the file, flip a single `disabled` flag, and
 * write it back with 2-space indentation, preserving every other field.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { detailOf, type McpScope, type McpServer, type McpServerConfig, transportOf } from "./types.js";

const log = createLogger("mcp:config");

interface McpFile {
  mcpServers?: Record<string, McpServerConfig>;
  [k: string]: unknown;
}

/** Absolute path of the global mcp.json. */
export function globalMcpPath(): string {
  return join(homedir(), ".kiro", "settings", "mcp.json");
}

/** Absolute path of a workspace mcp.json for a given project directory. */
export function workspaceMcpPath(cwd: string): string {
  return join(cwd, ".kiro", "settings", "mcp.json");
}

function readFile(path: string): McpFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as McpFile;
  } catch (e) {
    log.warn(`cannot parse ${path}: ${(e as Error).message}`);
    return undefined;
  }
}

function serversFrom(path: string, scope: McpScope): McpServer[] {
  const file = readFile(path);
  const map = file?.mcpServers;
  if (!map || typeof map !== "object") return [];
  return Object.entries(map).map(([name, config]) => ({
    name,
    scope,
    configPath: path,
    disabled: config?.disabled === true,
    transport: transportOf(config ?? {}),
    detail: detailOf(config ?? {}),
    config: config ?? {},
  }));
}

/**
 * List all configured MCP servers. Workspace entries shadow global ones with
 * the same name. Returns them sorted by name (case-insensitive).
 */
export function listMcpServers(cwd?: string): McpServer[] {
  const byName = new Map<string, McpServer>();
  for (const s of serversFrom(globalMcpPath(), "global")) byName.set(s.name, s);
  if (cwd) {
    for (const s of serversFrom(workspaceMcpPath(cwd), "workspace")) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Locate a single server by name (workspace shadows global). */
export function findMcpServer(name: string, cwd?: string): McpServer | undefined {
  return listMcpServers(cwd).find((s) => s.name === name);
}

export interface ToggleResult {
  ok: boolean;
  /** New disabled state on success. */
  disabled?: boolean;
  error?: string;
}

/**
 * Set the `disabled` flag for a server in its own config file. The change takes
 * effect when the agent next (re)loads servers (after `/restart` / new session).
 */
export function setMcpDisabled(server: McpServer, disabled: boolean): ToggleResult {
  const file = readFile(server.configPath);
  if (!file || !file.mcpServers || !file.mcpServers[server.name]) {
    return { ok: false, error: `server "${server.name}" not found in ${server.configPath}` };
  }
  const entry = file.mcpServers[server.name]!;
  if (disabled) entry.disabled = true;
  else delete entry.disabled; // absence === enabled; keeps the file clean
  try {
    writeFileSync(server.configPath, JSON.stringify(file, null, 2) + "\n", "utf-8");
    return { ok: true, disabled };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
