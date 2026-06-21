/**
 * Types for MCP (Model Context Protocol) server inspection & control.
 *
 * Kiro CLI loads MCP servers from JSON config files: a global one at
 * `~/.kiro/settings/mcp.json` (the "default" scope used by the default agent)
 * and an optional per-workspace `<cwd>/.kiro/settings/mcp.json`. Each server may
 * carry a `disabled` flag; toggling it enables/disables the server (applied the
 * next time the agent (re)loads — i.e. after `/restart` or a new session).
 */

export type McpScope = "global" | "workspace";
export type McpTransport = "http" | "stdio" | "unknown";

/** Raw server definition as stored in an mcp.json `mcpServers` entry. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  timeout?: number;
  disabled?: boolean;
  autoApprove?: string[];
  [k: string]: unknown;
}

/** A configured server resolved from a specific config file. */
export interface McpServer {
  name: string;
  scope: McpScope;
  /** Absolute path of the config file this server is defined in. */
  configPath: string;
  disabled: boolean;
  transport: McpTransport;
  /** Short transport descriptor for display (command or url, trimmed). */
  detail: string;
  config: McpServerConfig;
}

/** Result of a live connection probe (MCP `initialize` handshake). */
export interface McpProbeResult {
  name: string;
  ok: boolean;
  /** Round-trip time in ms when ok. */
  ms?: number;
  /** Server-reported name/version when ok. */
  serverName?: string;
  serverVersion?: string;
  /** Human-readable failure reason when not ok. */
  error?: string;
  /** True when the server was skipped because it is disabled. */
  skipped?: boolean;
}

export function transportOf(c: McpServerConfig): McpTransport {
  if (typeof c.url === "string" && c.url.trim()) return "http";
  if (typeof c.command === "string" && c.command.trim()) return "stdio";
  return "unknown";
}

export function detailOf(c: McpServerConfig): string {
  if (typeof c.url === "string" && c.url.trim()) return c.url.trim();
  if (typeof c.command === "string" && c.command.trim()) {
    const args = Array.isArray(c.args) && c.args.length ? " " + c.args.join(" ") : "";
    return (c.command + args).trim();
  }
  return "(no command/url)";
}
