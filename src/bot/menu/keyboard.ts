/**
 * The always-visible reply keyboard. Stateful buttons (Project / Agent /
 * Reasoning / Model) show the CURRENT value and are matched by their emoji
 * prefix; the rest are fixed actions.
 */
import { Keyboard } from "grammy";
import { reasoningLabel } from "../../app/reasoning.js";
import type { ChatSettings } from "../../app/types.js";

export const PREFIX = { project: "\u{1F4C1}", agent: "\u{1F916}", reasoning: "\u{1F9E0}", model: "\u{1F9E9}" };
export const FIXED = {
  sessions: "\u{1F5C2} Sessions",
  tasks: "\u2705 Tasks",
  status: "\u{1F4CA} Status",
  newSession: "\u{1F195} New",
  stop: "\u23F9 Stop",
};
export const FIXED_LABELS = Object.values(FIXED);
export const STATEFUL_RE = /^(\u{1F4C1}|\u{1F916}|\u{1F9E0}|\u{1F9E9})\s/u;

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

export function mainKeyboard(s: ChatSettings, projectName?: string): Keyboard {
  const proj = projectName || s.projectName || "Project";
  return new Keyboard()
    .text(`${PREFIX.project} ${trunc(proj, 18)}`)
    .text(`${PREFIX.agent} ${trunc(s.agent || "default", 16)}`)
    .row()
    .text(`${PREFIX.reasoning} ${reasoningLabel(s.reasoning)}`)
    .text(`${PREFIX.model} ${s.model ? trunc(s.model, 16) : "Model"}`)
    .row()
    .text(FIXED.sessions)
    .text(FIXED.tasks)
    .row()
    .text(FIXED.status)
    .text(FIXED.newSession)
    .text(FIXED.stop)
    .resized()
    .persistent();
}
