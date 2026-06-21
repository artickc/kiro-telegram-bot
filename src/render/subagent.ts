/**
 * Render subagent ("crew") activity into short, readable status lines so the
 * user can see what's happening while the main agent waits on its subagents.
 */
import type { PendingStage, SubagentInfo } from "../acp/types.js";

const STATUS_ICON: Record<string, string> = {
  working: "\u{1F3C3}", // 🏃 running
  running: "\u{1F3C3}",
  pending: "\u23F3",
  queued: "\u23F3",
  completed: "\u2705",
  done: "\u2705",
  terminated: "\u2705",
  failed: "\u274C",
  error: "\u274C",
  cancelled: "\u23F9",
};

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

/** Normalize a subagent's status type to a short, stable key. */
export function statusKey(s: SubagentInfo): string {
  return (s.status?.type || "working").toLowerCase();
}

/** A one-line label for a subagent (no leading icon). */
export function subagentLabel(s: SubagentInfo): string {
  const name = s.sessionName || s.agentName || s.sessionId.slice(0, 8);
  const role = s.role || s.agentName;
  return role && role !== name ? `${name} (${role})` : name;
}

/**
 * A markdown block announcing a subagent's status transition, or "" to skip.
 * `kind`: "start" the first time it appears, otherwise from its status.
 */
export function renderSubagentTransition(s: SubagentInfo, kind: "start" | "status"): string {
  const key = statusKey(s);
  const label = subagentLabel(s);
  if (kind === "start") {
    const q = s.initialQuery ? `\n    \u2197 ${trunc(s.initialQuery.trim(), 140)}` : "";
    return `\u{1F916} Subagent **${label}** started${q}`;
  }
  const icon = STATUS_ICON[key] ?? "\u{1F916}";
  const verb =
    key === "terminated" || key === "completed" || key === "done"
      ? "finished"
      : key === "failed" || key === "error"
        ? "failed"
        : key;
  const msg = s.status?.message && !/^running$/i.test(s.status.message) ? ` \u2014 ${trunc(s.status.message, 80)}` : "";
  return `${icon} Subagent **${label}** ${verb}${msg}`;
}

/** A compact summary for the status panel, e.g. "🤖 2 running · 1 pending". */
export function subagentSummary(subagents: SubagentInfo[], pending: PendingStage[]): string | undefined {
  const running = subagents.filter((s) => {
    const k = statusKey(s);
    return k === "working" || k === "running" || k === "pending" || k === "queued";
  }).length;
  const pend = pending.length;
  if (running === 0 && pend === 0) return undefined;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (pend > 0) parts.push(`${pend} pending`);
  return `\u{1F916} ${parts.join(" \u00B7 ")}`;
}

/** True when a status type means the subagent is still active. */
export function isActiveStatus(key: string): boolean {
  return key === "working" || key === "running" || key === "pending" || key === "queued";
}
