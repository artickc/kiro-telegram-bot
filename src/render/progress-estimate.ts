/**
 * Bot-side FALLBACK task-progress estimate.
 *
 * The primary progress signal is the `{progress: N%}` marker the agent is asked
 * to emit (see PROGRESS_DIRECTIVE). But that marker is only an *instruction* the
 * model can ignore — weaker/free models and long, tool-heavy turns frequently
 * never emit one, leaving the bar empty for the whole turn. This module gives
 * the bot a way to show a live, advancing bar anyway, derived ONLY from real,
 * observable work signals (never random):
 *
 *   • completed tool calls   — each is concrete progress, weighted most
 *   • streamed prose chars    — the agent explaining / answering
 *   • streamed thinking chars — reasoning volume (weighted least)
 *   • elapsed time            — a small, slow contribution so a quiet turn still creeps
 *
 * The estimate is monotonic by construction (every input only grows during a
 * turn) and asymptotically capped well below 100 while running, so the bar never
 * claims "done" on its own — the caller pushes 100 only when the turn actually
 * completes. The agent's own marker, when present, always takes precedence.
 */

/** Observable, monotonically-increasing signals collected during one turn. */
export interface ActivitySignals {
  /** Number of tool calls / subagent transitions shown this turn. */
  toolCalls: number;
  /** Characters of agent prose streamed this turn. */
  outputChars: number;
  /** Characters of agent thinking streamed this turn. */
  thoughtChars: number;
  /** Milliseconds since the turn started. */
  elapsedMs: number;
}

/** Hard ceiling for the fallback while a turn is still running. The agent (or
 *  turn completion) is the only thing allowed to take the bar to 100. */
export const FALLBACK_RUNNING_CAP = 90;

/** Minimum shown once *any* work signal is present (so the bar never sits at 0
 *  while the agent is clearly busy). */
const FALLBACK_FLOOR = 5;

/** Controls how quickly the asymptotic curve approaches the cap. Larger = slower. */
const CURVE_K = 6;

/**
 * Map real work signals to a 0–FALLBACK_RUNNING_CAP estimate via a saturating
 * curve `cap * (1 - e^(-units/K))`. Tool calls dominate because each is a
 * discrete, completed step; text volume and elapsed time add gentle, diminishing
 * contributions so a turn that's only thinking still advances slowly.
 */
export function estimateProgress(s: ActivitySignals): number {
  const units =
    Math.max(0, s.toolCalls) * 1.0 +
    Math.max(0, s.outputChars) / 400 +
    Math.max(0, s.thoughtChars) / 1500 +
    Math.max(0, s.elapsedMs) / 30_000;

  if (units <= 0) return 0;

  const raw = FALLBACK_RUNNING_CAP * (1 - Math.exp(-units / CURVE_K));
  const clamped = Math.min(FALLBACK_RUNNING_CAP, Math.max(FALLBACK_FLOOR, raw));
  return Math.round(clamped);
}
