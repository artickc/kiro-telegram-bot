/**
 * Builds a rich, readable "card" for a single Kiro session: a plain-text body
 * (no MarkdownV2 so Windows paths and titles never need escaping) plus an
 * inline keyboard with Connect / History / Watch actions.
 *
 * Callback data is unchanged (`sess:` / `hist:` / `watch:` + UUID) so the
 * existing handlers in sessions.ts keep working.
 */
import { InlineKeyboard } from "grammy";
import { basename } from "node:path";
import type { SessionMeta } from "../../sessions/types.js";

export interface SessionCardExtras {
  /** Context-usage %, when the session is loaded in the current ACP process. */
  contextPct?: number;
}

export interface SessionCard {
  text: string;
  keyboard: InlineKeyboard;
}

/** Build the card body + buttons for one session. */
export function buildSessionCard(m: SessionMeta, extra: SessionCardExtras = {}): SessionCard {
  const dot = m.active ? "\u{1F7E2}" : "\u26AA";
  const state = m.active ? `running${m.lockPid ? ` \u00B7 pid ${m.lockPid}` : ""}` : "idle";
  const proj = m.cwd ? basename(m.cwd) : "(no project)";

  const lines = [`${dot} ${m.title}`, `\u{1F4C1} ${proj}`];
  if (m.cwd) lines.push(`   ${m.cwd}`);
  lines.push(`\u{1F552} updated ${relTime(m.updatedAt)} \u00B7 created ${relTime(m.createdAt)}`);
  const ctx = typeof extra.contextPct === "number" ? ` \u00B7 \u{1F9E0} ctx ${Math.round(extra.contextPct)}%` : "";
  lines.push(`\u{1F4CA} ${state} \u00B7 \u{1F4DC} history ${humanSize(m.historyBytes)}${ctx}`);
  lines.push(`\u{1F194} ${m.sessionId.slice(0, 8)}`);

  const connect = m.active ? "\u{1F374} Continue (fork)" : "\u{1F517} Resume";
  const keyboard = new InlineKeyboard()
    .text(connect, `sess:${m.sessionId}`)
    .text("\u{1F4DC} History", `hist:${m.sessionId}`)
    .text("\u{1F4E1} Watch", `watch:${m.sessionId}`);

  return { text: lines.join("\n"), keyboard };
}

/** Compact relative time, e.g. "42s ago", "5m ago", "3h ago", "2d ago". */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Human-readable byte size, e.g. "812 B", "42.3 KB", "1.2 MB". */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
