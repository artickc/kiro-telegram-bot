/**
 * History parser — turns a session's .jsonl event log into readable entries.
 * Reads only the tail of large logs to stay fast.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { HistoryEntry, HistoryRole } from "./types.js";

const TAIL_WINDOWS = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]; // grow until entries found

interface RawEvent {
  kind?: string;
  data?: {
    content?: Array<{ kind?: string; data?: unknown; text?: unknown }>;
    meta?: { timestamp?: number };
    name?: string;
    tool_name?: string;
  };
}

/** Parse the most recent `maxEntries` history entries from a session log. */
export function readHistory(jsonlPath: string, maxEntries = 20): HistoryEntry[] {
  for (const window of TAIL_WINDOWS) {
    const entries = parseTail(jsonlPath, window, maxEntries);
    if (entries.length > 0) return entries;
  }
  return [];
}

/** Current byte size of a session log (0 if missing). */
export function jsonlSize(jsonlPath: string): number {
  try {
    return statSync(jsonlPath).size;
  } catch {
    return 0;
  }
}

/**
 * Read the entries appended after `fromByte` (the "unread" since last seen).
 * Returns the parsed entries and the new end-of-file byte offset. Kiro appends
 * whole newline-terminated JSON objects, so `fromByte` is always a line boundary.
 */
export function readEntriesFrom(jsonlPath: string, fromByte: number): { entries: HistoryEntry[]; size: number } {
  const size = jsonlSize(jsonlPath);
  if (size <= fromByte || size === 0) return { entries: [], size };
  const length = size - fromByte;
  const fd = openSync(jsonlPath, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, fromByte);
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim().length > 0);
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      const e = parseEventLine(line);
      if (e) entries.push(e);
    }
    return { entries, size };
  } finally {
    closeSync(fd);
  }
}

function parseTail(jsonlPath: string, window: number, maxEntries: number): HistoryEntry[] {
  const text = readTail(jsonlPath, window);
  if (!text) return [];

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: HistoryEntry[] = [];

  for (const line of lines) {
    const entry = parseEventLine(line);
    if (entry) entries.push(entry);
  }

  return entries.slice(-maxEntries);
}

/** Parse a single .jsonl event line into a history entry (or undefined). */
export function parseEventLine(line: string): HistoryEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let ev: RawEvent;
  try {
    ev = JSON.parse(trimmed) as RawEvent;
  } catch {
    return undefined;
  }
  return toEntry(ev);
}

/** Build a compact plain-text transcript from history entries (for priming). */
export function buildTranscript(entries: HistoryEntry[], perEntryMax = 600): string {
  const label: Record<string, string> = {
    user: "User",
    assistant: "Assistant",
    tool: "Tool",
    system: "System",
  };
  return entries
    .map((e) => {
      const text = e.text.length > perEntryMax ? e.text.slice(0, perEntryMax) + " …" : e.text;
      return `${label[e.role] ?? e.role}: ${text}`;
    })
    .join("\n");
}

function toEntry(ev: RawEvent): HistoryEntry | undefined {
  const role = roleOf(ev.kind);
  if (!role) return undefined;

  const text = extractText(ev.data?.content);
  const tool = ev.data?.tool_name || ev.data?.name;
  if (!text && !tool) return undefined;

  return {
    role,
    text: text || (tool ? `(${tool})` : ""),
    tool,
    timestamp: ev.data?.meta?.timestamp,
  };
}

function roleOf(kind?: string): HistoryRole | undefined {
  switch (kind) {
    case "Prompt":
    case "UserMessage":
      return "user";
    case "AssistantMessage":
    case "Response":
      return "assistant";
    case "ToolUse":
    case "ToolUseResults":
      return "tool";
    default:
      return undefined;
  }
}

function extractText(content?: Array<{ kind?: string; data?: unknown; text?: unknown }>): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block.kind === "text") {
      if (typeof block.data === "string") parts.push(block.data);
      else if (block.data && typeof (block.data as { text?: unknown }).text === "string") {
        parts.push((block.data as { text: string }).text);
      }
    } else if (typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("").trim();
}

/** Read up to `maxBytes` from the end of a file as UTF-8 text. */
function readTail(path: string, maxBytes: number): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";

  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf-8");
    // If we started mid-file, drop the partial first line.
    if (start > 0) {
      const nl = text.indexOf("\n");
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}
