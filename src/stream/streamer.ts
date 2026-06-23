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

  constructor(
    private readonly api: Api,
    private readonly chatId: number,
    private readonly throttleMs: number,
    private replyTo?: number,
  ) {}

  /** reply_parameters for the FIRST message only (threads the reply to the
   *  prompt), then cleared so later chunks/edits don't repeat it. */
  private replyExtra(): Record<string, unknown> {
    if (this.replyTo === undefined) return {};
    const extra = { reply_parameters: { message_id: this.replyTo, allow_sending_without_reply: true } };
    this.replyTo = undefined;
    return extra;
  }

  appendOutput(text: string): void {
    if (!text) return;
    this.merge("out", text);
    this.schedule();
  }

  appendThought(text: string): void {
    if (!text) return;
    this.merge("think", text);
    this.schedule();
  }

  addTool(rawMarkdown: string): void {
    if (!rawMarkdown) return;
    this.segs.push({ kind: "tool", text: rawMarkdown });
    this.schedule();
  }

  get hasOutput(): boolean {
    return this.liveId !== undefined || this.segs.some((s) => s.text.trim().length > 0);
  }

  async finalize(footer?: string): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Append a footer (e.g. searchable hashtags) to the tail of the response —
    // but only if the agent actually produced output, so we never send a
    // message that is just tags.
    if (footer && this.hasOutput) this.segs.push({ kind: "out", text: footer });
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
      const src = renderSegs(this.segs.slice(this.sealedIdx));
      if (!src.trim()) return;
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
    const src = renderSegs(this.segs.slice(from, to));
    if (!src.trim()) return;
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
