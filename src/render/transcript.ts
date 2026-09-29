/**
 * Render parsed transcript turns into a downloadable document for /export:
 * Markdown (default — headings per turn, tool calls as a bullet list) or plain
 * text. Pure functions, so the output is unit-testable.
 */
import { basename } from "node:path";
import type { TranscriptPart, TranscriptTurn } from "../sessions/types.js";

export type TranscriptFormat = "md" | "txt";

export interface TranscriptInfo {
  sessionId: string;
  title?: string;
  cwd?: string;
  exportedAt: Date;
  /** The log was larger than the read cap, so only its most recent part is included. */
  truncated?: boolean;
  /** Human-readable size of that cap (e.g. "32 MB"), shown with `truncated`. */
  maxLabel?: string;
}

export interface TranscriptStats {
  prompts: number;
  replies: number;
  toolCalls: number;
}

/** "3 prompts · 1 reply · 12 tool calls" */
export function describeStats(s: TranscriptStats): string {
  return `${plural(s.prompts, "prompt")} \u00B7 ${plural(s.replies, "reply", "replies")} \u00B7 ${plural(s.toolCalls, "tool call")}`;
}

/** The session title, or "Session <id8>" when Kiro never named it. */
export function transcriptTitle(info: TranscriptInfo): string {
  const t = (info.title ?? "").trim();
  return t && t !== "(untitled)" ? t : `Session ${info.sessionId.slice(0, 8)}`;
}

export function transcriptStats(turns: TranscriptTurn[]): TranscriptStats {
  let prompts = 0;
  let replies = 0;
  let toolCalls = 0;
  for (const t of turns) {
    if (t.role === "user") prompts++;
    else replies++;
    for (const p of t.parts) if (p.kind === "tool") toolCalls++;
  }
  return { prompts, replies, toolCalls };
}

/** Render the whole transcript as a Markdown or plain-text document. */
export function renderTranscript(turns: TranscriptTurn[], info: TranscriptInfo, format: TranscriptFormat): string {
  return format === "txt" ? renderText(turns, info) : renderMarkdown(turns, info);
}

/** `kiro-transcript-<project>-<session8>-<YYYYMMDD-HHMM>.<md|txt>` */
export function transcriptFilename(info: TranscriptInfo, format: TranscriptFormat): string {
  const project = slug(info.cwd ? basename(info.cwd) : "") || "session";
  const sid = slug(info.sessionId.slice(0, 8)) || "unknown";
  const d = info.exportedAt;
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `kiro-transcript-${project}-${sid}-${stamp}.${format}`;
}

/** Local "YYYY-MM-DD HH:MM" (the bot host's timezone). */
export function formatLocal(ms: number | Date): string {
  const d = ms instanceof Date ? ms : new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function renderMarkdown(turns: TranscriptTurn[], info: TranscriptInfo): string {
  const out: string[] = [`# \u{1F4DC} ${transcriptTitle(info)}`, "", ...headerLines(turns, info).map((l) => `- ${l}`)];
  if (info.truncated) out.push("", `> \u26A0\uFE0F ${truncationNote(info)}`);
  out.push("", "---");
  for (const turn of turns) {
    const when = turn.timestamp !== undefined ? ` \u00B7 ${formatLocal(turn.timestamp)}` : "";
    out.push("", turn.role === "user" ? `## \u{1F464} You${when}` : `## \u{1F916} Kiro${when}`);
    for (const group of groupParts(turn.parts)) {
      out.push("");
      if (group.kind === "text") out.push(group.text);
      else out.push(...group.tools.map((t) => `- \u{1F527} ${inlineCode(t.name)}${t.preview ? ` \u2014 ${inlineCode(t.preview)}` : ""}`));
    }
  }
  return `${out.join("\n")}\n`;
}

// ── Plain text ───────────────────────────────────────────────────────────────

function renderText(turns: TranscriptTurn[], info: TranscriptInfo): string {
  const rule = "=".repeat(72);
  const out: string[] = [`Kiro session transcript \u2014 ${transcriptTitle(info)}`, ...headerLines(turns, info, false)];
  if (info.truncated) out.push(`NOTE: ${truncationNote(info)}`);
  for (const turn of turns) {
    const when = turn.timestamp !== undefined ? ` \u00B7 ${formatLocal(turn.timestamp)}` : "";
    out.push("", rule, `${turn.role === "user" ? "YOU" : "KIRO"}${when}`, rule);
    for (const group of groupParts(turn.parts)) {
      out.push("");
      if (group.kind === "text") out.push(group.text);
      else out.push(...group.tools.map((t) => `  [tool] ${t.name}${t.preview ? ` \u2014 ${t.preview}` : ""}`));
    }
  }
  return `${out.join("\n")}\n`;
}

// ── shared helpers ───────────────────────────────────────────────────────────

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type PartGroup = { kind: "text"; text: string } | { kind: "tools"; tools: ToolPart[] };

/** Group consecutive tool calls so they render as one compact list. */
function groupParts(parts: TranscriptPart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  for (const p of parts) {
    const last = groups.at(-1);
    if (p.kind === "text") groups.push({ kind: "text", text: p.text });
    else if (last?.kind === "tools") last.tools.push(p);
    else groups.push({ kind: "tools", tools: [p] });
  }
  return groups;
}

function headerLines(turns: TranscriptTurn[], info: TranscriptInfo, markdown = true): string[] {
  const s = transcriptStats(turns);
  const b = (label: string): string => (markdown ? `**${label}:**` : `${label}:`);
  const code = (v: string): string => (markdown ? inlineCode(v) : v);
  const lines: string[] = [];
  if (info.cwd) lines.push(`${b("Project")} ${basename(info.cwd) || info.cwd} (${code(info.cwd)})`);
  lines.push(`${b("Session")} ${code(info.sessionId)}`);
  lines.push(`${b("Exported")} ${formatLocal(info.exportedAt)}`);
  lines.push(`${b("Messages")} ${describeStats(s)}`);
  return lines;
}

function truncationNote(info: TranscriptInfo): string {
  const cap = info.maxLabel ? ` than ${info.maxLabel}` : "";
  return `This session's log is larger${cap}, so only its most recent part is included.`;
}

/** Wrap text in a Markdown code span that survives embedded backticks. */
function inlineCode(v: string): string {
  const longest = Math.max(0, ...[...v.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const space = longest > 0 ? " " : "";
  return `${fence}${space}${v}${space}${fence}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function slug(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
