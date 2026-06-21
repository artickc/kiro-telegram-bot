/**
 * Transient-prompt retry policy + the user-facing copy that goes with it.
 *
 * Policy: when a prompt fails with a *transient* agent error (e.g. "high volume
 * of traffic" / -32603 "Internal error") **before any output streamed**, wait
 * and retry with an exponential backoff that starts at 6s and doubles up to a
 * 60s (1 minute) cap, then gives up with a summary. The user always sees the
 * real error text on every attempt — we only add the retry/▶ summary line.
 */

/** First backoff delay (ms). */
export const RETRY_BASE_MS = 6_000;
/** Maximum backoff delay (ms) — "up to 1 minute". */
export const RETRY_CAP_MS = 60_000;

/**
 * Backoff delays (ms) preceding each retry, doubling from {@link RETRY_BASE_MS}
 * and capped at {@link RETRY_CAP_MS}. The schedule stops once it hits the cap,
 * and never exceeds `maxRetries` entries.
 *
 * `maxRetries >= 5` ⇒ `[6000, 12000, 24000, 48000, 60000]`.
 */
export function backoffSchedule(maxRetries: number): number[] {
  const out: number[] = [];
  let delay = RETRY_BASE_MS;
  for (let i = 0; i < maxRetries; i++) {
    out.push(Math.min(delay, RETRY_CAP_MS));
    if (delay >= RETRY_CAP_MS) break;
    delay *= 2;
  }
  return out;
}

/** Human-friendly seconds label, e.g. 6000 → "6s", 90000 → "1m 30s". */
export function fmtSeconds(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * Message shown when an attempt fails but another retry is scheduled. Shows the
 * real error verbatim so the user can act on it (e.g. switch model), plus when
 * the next attempt runs.
 */
export function formatRetryNotice(
  error: Error,
  nextAttempt: number,
  totalAttempts: number,
  waitMs: number,
): string {
  return [
    `\u26A0\uFE0F ${error.message}`,
    "",
    `\u{1F501} Retrying in ${fmtSeconds(waitMs)} \u2014 attempt ${nextAttempt} of ${totalAttempts}\u2026`,
  ].join("\n");
}

/** Final summary shown after all retries are exhausted (or retry was unsafe). */
export function formatErrorSummary(error: Error, elapsed: string, attempts: number, transient: boolean): string {
  const tip = transient
    ? "\n\n\u{1F4A1} Try a different model (tap \u{1F9E9} Model or /model <id>), or send again later."
    : "";
  if (attempts <= 1) {
    return `\u274C Error after ${elapsed}: ${error.message}${tip}`;
  }
  return `\u274C Gave up after ${attempts} attempts over ${elapsed}.\nLast error: ${error.message}${tip}`;
}
