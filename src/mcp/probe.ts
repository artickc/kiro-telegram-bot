/**
 * MCP health probe — performs a real MCP `initialize` JSON-RPC handshake against
 * a configured server to determine whether it actually connects, and why not.
 *
 *   • stdio servers → spawn the command (args/env), write `initialize` to stdin,
 *     await a matching JSON-RPC response on stdout, then kill the process.
 *   • http servers  → POST `initialize` to the URL (with headers); accept either
 *     a JSON body or an SSE `data:` line (Streamable HTTP transport).
 *
 * This mirrors exactly what an MCP client does on connect, so a success means
 * the server is reachable and speaks MCP; a failure carries the real reason
 * (command not found, timeout, HTTP status, transport error, …).
 */
import { spawn } from "node:child_process";
import { createLogger } from "../logger.js";
import type { McpProbeResult, McpServer } from "./types.js";

const log = createLogger("mcp:probe");

const INIT_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "kiro-telegram-bot", version: "1.0.0" },
  },
};

export interface ProbeOptions {
  timeoutMs: number;
  concurrency: number;
}

/** Probe a single server. Never throws — failures are returned as results. */
export async function probeServer(server: McpServer, timeoutMs: number): Promise<McpProbeResult> {
  if (server.disabled) return { name: server.name, ok: false, skipped: true, error: "disabled" };
  const start = Date.now();
  try {
    const info = server.transport === "http" ? await probeHttp(server, timeoutMs) : await probeStdio(server, timeoutMs);
    return { name: server.name, ok: true, ms: Date.now() - start, serverName: info.name, serverVersion: info.version };
  } catch (e) {
    return { name: server.name, ok: false, ms: Date.now() - start, error: (e as Error).message };
  }
}

/** Probe many servers with bounded concurrency. Disabled servers are skipped. */
export async function probeAll(
  servers: McpServer[],
  opts: ProbeOptions,
  onResult?: (r: McpProbeResult, done: number, total: number) => void,
): Promise<McpProbeResult[]> {
  const results: McpProbeResult[] = new Array(servers.length);
  let next = 0;
  let done = 0;
  const total = servers.length;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= servers.length) return;
      const r = await probeServer(servers[i]!, opts.timeoutMs);
      results[i] = r;
      done++;
      try {
        onResult?.(r, done, total);
      } catch {
        /* non-fatal */
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(opts.concurrency, servers.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

interface ServerIdent {
  name?: string;
  version?: string;
}

function identFrom(result: unknown): ServerIdent {
  const r = result as { serverInfo?: { name?: string; version?: string } };
  return { name: r?.serverInfo?.name, version: r?.serverInfo?.version };
}

/** stdio handshake: spawn, send initialize, await a JSON-RPC response. */
function probeStdio(server: McpServer, timeoutMs: number): Promise<ServerIdent> {
  return new Promise<ServerIdent>((resolve, reject) => {
    const cmd = server.config.command;
    if (!cmd) return reject(new Error("no command configured"));
    const args = Array.isArray(server.config.args) ? server.config.args.map(String) : [];
    let settled = false;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(server.config.env ?? {}) },
        windowsHide: true,
      });
    } catch (e) {
      return reject(new Error(`spawn failed: ${(e as Error).message}`));
    }

    const finish = (err?: Error, ident?: ServerIdent): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(ident ?? {});
    };

    const timer = setTimeout(() => finish(new Error(`timeout after ${timeoutMs}ms (no response)`)), timeoutMs);

    let stderrTail = "";
    let buf = "";
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { message?: string } };
          if (m && m.id === 1) {
            if (m.error) finish(new Error(`server error: ${m.error.message ?? "unknown"}`));
            else finish(undefined, identFrom(m.result));
            return;
          }
        } catch {
          /* partial / non-JSON banner line — keep reading */
        }
      }
    });
    proc.stderr?.setEncoding("utf-8");
    proc.stderr?.on("data", (c: string) => {
      stderrTail = (stderrTail + c).slice(-300);
    });
    proc.on("error", (e) => finish(new Error(`spawn failed: ${e.message}`)));
    proc.on("exit", (code) => {
      if (!settled) {
        const tail = stderrTail.trim() ? ` — ${stderrTail.trim().split("\n").pop()}` : "";
        finish(new Error(`process exited (code ${code})${tail}`));
      }
    });

    try {
      proc.stdin?.write(JSON.stringify(INIT_REQUEST) + "\n");
    } catch (e) {
      finish(new Error(`write failed: ${(e as Error).message}`));
    }
  });
}

/** HTTP handshake: POST initialize; parse JSON or an SSE `data:` payload. */
async function probeHttp(server: McpServer, timeoutMs: number): Promise<ServerIdent> {
  const url = server.config.url!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(server.config.headers ?? {}),
      },
      body: JSON.stringify(INIT_REQUEST),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const text = await res.text();
    const parsed = parseJsonOrSse(text);
    if (!parsed) throw new Error("no JSON-RPC result in response");
    if (parsed.error) throw new Error(`server error: ${parsed.error.message ?? "unknown"}`);
    return identFrom(parsed.result);
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? `timeout after ${timeoutMs}ms` : (e as Error).message;
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

interface RpcEnvelope {
  result?: unknown;
  error?: { message?: string };
}

/** Accept a plain JSON body or SSE frames (`event: …\n data: {json}`). */
function parseJsonOrSse(text: string): RpcEnvelope | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as RpcEnvelope;
  } catch {
    /* maybe SSE */
  }
  for (const line of trimmed.split("\n")) {
    const m = /^data:\s*(.+)$/.exec(line.trim());
    if (m) {
      try {
        return JSON.parse(m[1]!) as RpcEnvelope;
      } catch {
        /* keep scanning */
      }
    }
  }
  log.debug("unparseable MCP HTTP response:", trimmed.slice(0, 120));
  return undefined;
}
