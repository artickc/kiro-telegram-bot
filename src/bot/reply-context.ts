/**
 * Reply context extraction.
 *
 * When a user's Telegram message is a *reply* to another message, the agent
 * should also receive what the user is responding to — otherwise a terse reply
 * like "fix this" or "why?" loses all meaning. This module pulls that reference
 * content out of an incoming message:
 *   1. an explicitly highlighted quote (Bot API 6.9+ `message.quote`), which is
 *      the most precise signal of what the user is pointing at, then
 *   2. the full replied-to message's text / caption / media descriptor, then
 *   3. a reply to a message from another chat (`external_reply`).
 *
 * The result is capped so a reply to a huge agent answer can't blow the prompt.
 */
import type { Context } from "grammy";

/** Max characters of quoted context forwarded to the agent. */
const MAX_QUOTE_CHARS = 4000;

/** Structural subset of a Telegram message we can summarize. */
interface QuotableMessage {
  text?: string;
  caption?: string;
  document?: { file_name?: string };
  photo?: unknown;
  voice?: unknown;
  audio?: { file_name?: string };
  video?: unknown;
  video_note?: unknown;
  sticker?: { emoji?: string };
  location?: unknown;
  contact?: unknown;
}

/**
 * Build the reference-content string for a reply, or `undefined` when the
 * message isn't a reply / carries nothing quotable.
 */
export function extractReplyContext(ctx: Context): string | undefined {
  const msg = ctx.message;
  if (!msg) return undefined;

  const quote = msg.quote?.text?.trim() || undefined;
  const reply = msg.reply_to_message ? describeMessage(msg.reply_to_message) : undefined;
  const external = msg.external_reply ? describeMessage(msg.external_reply as QuotableMessage) : undefined;

  let context: string | undefined;
  if (quote && reply && reply !== quote) {
    // The user highlighted a specific part of a larger message — surface the
    // excerpt first (so it survives clipping) plus the fuller message context.
    context = `Quoted excerpt: "${quote}"\nFrom the message: ${reply}`;
  } else {
    context = quote ?? reply ?? external;
  }

  if (!context) return undefined;
  return clip(context, MAX_QUOTE_CHARS);
}

/** Human-readable content of a message: its text/caption or a media label. */
function describeMessage(m: QuotableMessage): string | undefined {
  const body = (m.text ?? m.caption)?.trim();
  if (body) return body;
  if (m.document) return `[file: ${m.document.file_name ?? "document"}]`;
  if (m.photo) return "[photo]";
  if (m.voice) return "[voice message]";
  if (m.audio) return `[audio: ${m.audio.file_name ?? "audio"}]`;
  if (m.video || m.video_note) return "[video]";
  if (m.sticker) return `[sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ""}]`;
  if (m.location) return "[location]";
  if (m.contact) return "[contact]";
  return undefined;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…(truncated)`;
}
