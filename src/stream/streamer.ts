/**
 * ResponseStreamer — renders a whole agent turn into as FEW Telegram messages as
 * possible, edited at most once per throttle window (anti-spam, avoids 429s).
 *
 * The turn is modelled as ordered segments so the transcript reads clearly:
 *   • plain prose      = the agent talking to you
 *   • > 💭 quoted block = the agent's thinking
 *   • 🔧 + code block   = tool calls / terminal commands / diffs
 *
 * A single "live" message is edited as content grows; only when it would exceed
 * Telegram's size limit is it sealed and a new live message started.
 */
import type { Api } from "grammy";
import { chunkMarkdown } from "../render/chunk.js";
import { toTelegramMarkdown } from "../render/markdown.js";
import { extractProgress, progressBar } from "../render/progress.js";
import { estimateProgress } from "../render/progress-estimate.js";
import { safeEdit, safeSend } from "../bot/telegram-io.js";

const SOFT_LIMIT = 3500;
const THINK_TAIL = 500;

type SegKind = "out" | "think" | "tool";
interface Seg {
  kind: SegKind;
  text: string;
}

export class ResponseStreamer {
  private readonly segs: Seg[] = [];
  private sealedIdx = 0;
  private liveId: number | undefined;
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private flushing = false;
  private closed = false;
  /** Latest task-progress % parsed from the agent's `{progress: N%}` markers
   *  (sticky across flushes; rendered as a bar on the live message). */
  private progress: number | undefined;
  /** True once the agent emitted a real `{progress}` marker — from then on its
   *  values are authoritative and the bot fallback stops contributing. */
  private agentReported = false;
  /** Real work signals for the fallback estimate (monotonic within a turn). */
  private toolCalls = 0;
  private outChars = 0;
  private thoughtChars = 0;

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly throttleMs: number,
    private replyTo?: number,
    private footer?: string,
    private readonly onProgress?: (pct: number) => void,
    /** Show a bot-computed bar when the agent emits no marker. */
    private readonly fallbackEnabled = false,
    /** Turn start time, used by the fallback's elapsed-time signal. */
    private readonly turnStartedAt = Date.now(),
  ) {}

  /** Replace the hashtag footer (used after a logical fork swaps the session id
   *  mid-turn, so the streamed response carries the NEW session's tags). */
  setFooter(footer: string): void {
    this.footer = footer;
  }

  /** "\n\n<footer>" appended to every finished message bubble (e.g. hashtags). */
  private footerSuffix(): string {
    return this.footer ? `\n\n${this.footer}` : "";
  }

  /** Strip `{progress: N%}` markers from rendered text, remembering the latest
   *  value (sticky across flushes) and notifying the owner when it changes. */
  private captureProgress(text: string): string {
    const { value, cleaned } = extractProgress(text);
    if (value !== undefined) this.setProgressValue(value, true);
    return cleaned;
  }

  /** Record a progress value, enforcing global monotonicity (never decreases)
   *  and notifying the owner on change. Agent markers are authoritative: once
   *  one arrives, the bot fallback stops contributing. */
  private setProgressValue(pct: number, fromAgent: boolean): void {
    if (fromAgent) this.agentReported = true;
    const next = Math.max(this.progress ?? 0, Math.round(pct));
    if (next === this.progress) return;
    this.progress = next;
    try {
      this.onProgress?.(next);
    } catch {
      /* non-fatal */
    }
  }

  /** Advance the fallback estimate from real activity signals, but only while
   *  the agent itself hasn't reported a value. No-op when fallback is off. */
  private applyFallback(): void {
    if (!this.fallbackEnabled || this.agentReported) return;
    const est = estimateProgress({
      toolCalls: this.toolCalls,
      outputChars: this.outChars,
      thoughtChars: this.thoughtChars,
      elapsedMs: Date.now() - this.turnStartedAt,
    });
    if (est > 0) this.setProgressValue(est, false);
  }

  /** Called when the turn finishes successfully: if the agent never reported
   *  its own progress, fill the fallback bar to 100. No-op otherwise. */
  completeFallback(): void {
    if (!this.fallbackEnabled || this.agentReported) return;
    this.setProgressValue(100, false);
  }

  /** reply_parameters threading EVERY message of the turn to the user's prompt,
   *  so the whole response (all bubbles, tool calls and continuations) stays in
   *  one thread — not just the first message. */
  private replyExtra(): Record<string, unknown> {
    if (this.replyTo === undefined) return {};
    return { reply_parameters: { message_id: this.replyTo, allow_sending_without_reply: true } };
  }

  appendOutput(text: string): void {
    if (!text) return;
    this.outChars += text.length;
    this.merge("out", text);
    this.schedule();
  }

  appendThought(text: string): void {
    if (!text) return;
    this.thoughtChars += text.length;
    this.merge("think", text);
    this.schedule();
  }

  addTool(rawMarkdown: string): void {
    if (!rawMarkdown) return;
    this.toolCalls += 1;
    this.segs.push({ kind: "tool", text: rawMarkdown });
    this.schedule();
  }

  get hasOutput(): boolean {
    return this.liveId !== undefined || this.segs.some((s) => s.text.trim().length > 0);
  }

  async finalize(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush(true);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private merge(kind: SegKind, text: string): void {
    const last = this.segs.at(-1);
    if (last && last.kind === kind) last.text += text;
    else this.segs.push({ kind, text });
  }

  private schedule(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(false);
    }, this.throttleMs);
  }

  private async flush(final: boolean): Promise<void> {
    if (this.flushing) {
      if (!final) this.schedule();
      return;
    }
    if (!this.dirty && !final) return;
    this.flushing = true;
    this.dirty = false;
    try {
      await this.sealOverflow();
      const base = this.captureProgress(renderSegs(this.segs.slice(this.sealedIdx)));
      this.applyFallback();
      // Never send an empty / progress-only bubble. The bar is appended only to
      // real streamed content; the live status panel shows the standalone bar.
      if (!base.trim()) return;
      // The live (still-streaming) bubble carries the hashtag footer AND a fresh
      // progress bar at the bottom (sealed bubbles below get neither bar).
      const parts: string[] = [base];
      if (this.progress !== undefined) parts.push(progressBar(this.progress));
      const src = `${parts.join("\n\n")}${this.footerSuffix()}`;
      const rendered = toTelegramMarkdown(src);
      const chunks = chunkMarkdown(rendered);
      const plain = chunkMarkdown(src);
      if (chunks.length <= 1) {
        const mdv2 = chunks[0] ?? rendered;
        if (this.liveId === undefined) this.liveId = await safeSend(this.api, this.chatId, mdv2, src, this.replyExtra());
        else await safeEdit(this.api, this.chatId, this.liveId, mdv2, src);
      } else {
        // Remainder no longer fits one message: flush all, last stays live.
        for (let i = 0; i < chunks.length; i++) {
          const mdv2 = chunks[i]!;
          const p = plain[i] ?? mdv2;
          if (i === 0 && this.liveId !== undefined) await safeEdit(this.api, this.chatId, this.liveId, mdv2, p);
          else if (i < chunks.length - 1) await safeSend(this.api, this.chatId, mdv2, p, this.replyExtra());
          else this.liveId = await safeSend(this.api, this.chatId, mdv2, p, this.replyExtra());
        }
        this.sealedIdx = this.segs.length; // everything before the live tail is sealed
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Seal leading segments into finalized messages while the live view is too big. */
  private async sealOverflow(): Promise<void> {
    let live = this.segs.slice(this.sealedIdx);
    while (live.length > 1 && toTelegramMarkdown(renderSegs(live)).length > SOFT_LIMIT) {
      const headCount = live.length - 1;
      await this.seal(this.sealedIdx, this.sealedIdx + headCount);
      this.sealedIdx += headCount;
      this.liveId = undefined;
      live = this.segs.slice(this.sealedIdx);
    }
  }

  private async seal(from: number, to: number): Promise<void> {
    const base = this.captureProgress(renderSegs(this.segs.slice(from, to)));
    if (!base.trim()) return;
    // A sealed bubble is finished, so it carries the footer (hashtags).
    const src = `${base}${this.footerSuffix()}`;
    const chunks = chunkMarkdown(toTelegramMarkdown(src));
    const plain = chunkMarkdown(src);
    for (let i = 0; i < chunks.length; i++) {
      const mdv2 = chunks[i]!;
      const p = plain[i] ?? mdv2;
      if (i === 0 && this.liveId !== undefined) await safeEdit(this.api, this.chatId, this.liveId, mdv2, p);
      else await safeSend(this.api, this.chatId, mdv2, p, this.replyExtra());
    }
  }
}

function renderSegs(segs: Seg[]): string {
  return segs
    .map((s) => {
      if (s.kind === "out") return s.text.trim();
      if (s.kind === "think") return quoteThought(s.text);
      return s.text.trim();
    })
    .filter((x) => x.length > 0)
    .join("\n\n");
}

function quoteThought(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const short = t.length > THINK_TAIL ? "…" + t.slice(-THINK_TAIL) : t;
  const lines = short.split("\n");
  return lines.map((l, i) => (i === 0 ? `> 💭 *thinking:* ${l}` : `> ${l}`)).join("\n");
}
