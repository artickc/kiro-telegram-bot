/**
 * Full-transcript parser for /export — turns a session's WHOLE .jsonl event log
 * into ordered conversation turns (user prompts, agent prose and the tools the
 * agent invoked), unlike `readHistory` which only samples the latest entries.
 *
 * Kiro logs (one JSON object per line):
 *   Prompt            → content [text]                    + meta.timestamp (s)
 *   AssistantMessage  → content [thinking | text | toolUse{name, input}]
 *   ToolResults       → content [toolResult]              (omitted: raw tool output)
 */
import { blockText, cleanStoredText, jsonlSize, type RawContentBlock, type RawEvent, readTail } from "./history.js";
import type { TranscriptPart, TranscriptTurn } from "./types.js";

/** Largest log slice read for one export. Bigger logs keep only their tail (the
 *  most recent conversation) so an export never balloons the bot's memory. */
export const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024;

const PREVIEW_MAX = 160;

export interface TranscriptRead {
  turns: TranscriptTurn[];
  /** True when the log exceeded `maxBytes` and only its tail was parsed. */
  truncated: boolean;
}

/** Read and parse a session log into transcript turns. */
export function readTranscript(jsonlPath: string, maxBytes = TRANSCRIPT_MAX_BYTES): TranscriptRead {
  const size = jsonlSize(jsonlPath);
  if (size === 0) return { turns: [], truncated: false };
  const text = readTail(jsonlPath, maxBytes);
  return { turns: parseTranscript(text.split("\n")), truncated: size > maxBytes };
}

/** Parse .jsonl lines into turns. Consecutive agent messages fold into one turn;
 *  unparseable lines, thinking blocks and tool results are skipped. */
export function parseTranscript(lines: Iterable<string>): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of lines) {
    const ev = parseLine(line);
    if (!ev) continue;
    const role = roleOf(ev.kind);
    if (!role) continue;
    const parts = partsOf(ev.data?.content);
    if (parts.length === 0) continue;

    const last = turns.at(-1);
    if (role === "assistant" && last?.role === "assistant") {
      for (const p of parts) pushPart(last.parts, p);
      continue;
    }
    const turn: TranscriptTurn = { role, parts: [] };
    for (const p of parts) pushPart(turn.parts, p);
    const ts = toEpochMs(ev.data?.meta?.timestamp);
    if (ts !== undefined) turn.timestamp = ts;
    turns.push(turn);
  }
  return turns;
}

/** One-line, length-capped summary of a tool's input (the shell command, search
 *  pattern, file path(s), URL …), or undefined when there's nothing useful. */
export function toolPreview(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  let s = "";
  if (typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const str = (k: string): string | undefined => {
      const v = rec[k];
      return typeof v === "string" && v.trim() ? v : undefined;
    };
    const path = str("path") ?? str("file_path") ?? str("filePath");
    const command = str("command");
    // File tools log a one-word operation next to the path ("create" + path);
    // shell tools log the full command line. Show the most telling field.
    if (command && path && !/\s/.test(command.trim())) s = `${command.trim()} ${path}`;
    else s = command ?? str("pattern") ?? str("query") ?? str("url") ?? path ?? operationPaths(rec.operations) ?? "";
    if (!s) s = JSON.stringify(input);
  } else {
    s = typeof input === "string" ? input : JSON.stringify(input);
  }
  s = s.replace(/\s+/g, " ").trim();
  if (!s || s === "{}" || s === "[]") return undefined;
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX - 1)}\u2026` : s;
}

/** Multi-file readers log `{operations: [{path}, …]}` — list those paths. */
function operationPaths(ops: unknown): string | undefined {
  if (!Array.isArray(ops)) return undefined;
  const paths = ops
    .map((op) => (op && typeof op === "object" ? (op as Record<string, unknown>).path : undefined))
    .filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return paths.length > 0 ? paths.join(", ") : undefined;
}

// ── internals ────────────────────────────────────────────────────────────────

function parseLine(line: string): RawEvent | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    const ev = JSON.parse(t) as unknown;
    return ev && typeof ev === "object" ? (ev as RawEvent) : undefined;
  } catch {
    return undefined; // a torn/partial line — skip it
  }
}

function roleOf(kind?: string): TranscriptTurn["role"] | undefined {
  switch (kind) {
    case "Prompt":
    case "UserMessage":
      return "user";
    case "AssistantMessage":
    case "Response":
      return "assistant";
    default:
      return undefined;
  }
}

/** Ordered prose + tool parts of one event (thinking and results dropped). */
function partsOf(content?: RawContentBlock[]): TranscriptPart[] {
  if (!Array.isArray(content)) return [];
  const parts: TranscriptPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.kind === "toolUse") {
      const data = (block.data ?? {}) as { name?: unknown; input?: unknown };
      const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : "tool";
      const preview = toolPreview(data.input);
      parts.push(preview ? { kind: "tool", name, preview } : { kind: "tool", name });
      continue;
    }
    const text = cleanStoredText(blockText(block)).trim();
    if (text) parts.push({ kind: "text", text });
  }
  return parts;
}

/** Append a part, merging adjacent prose so a turn reads as flowing text. */
function pushPart(parts: TranscriptPart[], part: TranscriptPart): void {
  const last = parts.at(-1);
  if (part.kind === "text" && last?.kind === "text") last.text = `${last.text}\n\n${part.text}`;
  else parts.push({ ...part });
}

/** Kiro stamps prompts in epoch SECONDS; accept ms too. */
function toEpochMs(ts: unknown): number | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return undefined;
  return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
}
