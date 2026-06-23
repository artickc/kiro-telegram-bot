/**
 * Plain text messages -> Kiro prompts.
 *
 * Telegram caps a single message at 4096 characters, so a long paste is
 * delivered to the bot as several back-to-back messages. Naively, each part
 * became its own queued turn ("Queued position 1…4") and a part that happened
 * to start with "/" was misread as an "Unknown command". We therefore COALESCE
 * rapid consecutive text messages per chat within a short debounce window
 * (`MESSAGE_BATCH_MS`) into a single prompt — one submission, one confirmation.
 *
 * While a turn is running, the combined message is queued and runs
 * automatically when the current turn finishes.
 * (Wizard input and menu-button text are intercepted by earlier handlers.)
 */
import type { Bot } from "grammy";
import { textPrompt } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";

const log = createLogger("message");

/** A pending burst of text messages from one chat, awaiting coalescing. */
interface TextBatch {
  parts: string[];
  ids: number[];
  timer: NodeJS.Timeout;
}

export function registerMessages(bot: Bot, deps: BotDeps): void {
  const batches = new Map<number, TextBatch>();
  const windowMs = deps.cfg.messageBatchMs;

  const arm = (chatId: number): NodeJS.Timeout =>
    setTimeout(() => void flush(deps, batches, chatId), windowMs);

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text.trim()) return;
    const chatId = ctx.chat.id;
    const id = ctx.message.message_id;

    const batch = batches.get(chatId);
    if (batch) {
      clearTimeout(batch.timer);
      batch.parts.push(text);
      batch.ids.push(id);
      batch.timer = arm(chatId);
      return;
    }
    batches.set(chatId, { parts: [text], ids: [id], timer: arm(chatId) });
  });
}

/** Coalesce a chat's buffered parts into one prompt and submit it once. */
async function flush(deps: BotDeps, batches: Map<number, TextBatch>, chatId: number): Promise<void> {
  const batch = batches.get(chatId);
  if (!batch) return;
  batches.delete(chatId);

  // Telegram splits at 4096 chars, almost always on a line boundary, so
  // rejoining with a newline reconstructs the original text faithfully.
  const combined = batch.parts.join("\n").trim();
  if (!combined) return;

  // A lone, single-line "/something" is an unknown-command typo — guide the
  // user instead of forwarding it to the agent. Split content never trips
  // this: it arrives as multiple parts, and multi-line text is never a command.
  if (batch.parts.length === 1 && !combined.includes("\n") && combined.startsWith("/")) {
    await send(deps, chatId, "Unknown command. Type /help to see what I can do.");
    return;
  }

  const rt = deps.registry.get(chatId);
  const note = batch.parts.length > 1 ? ` (combined ${batch.parts.length} messages)` : "";
  try {
    // Thread the reply to the prompt message (the user's message is left intact;
    // the agent's response + Done reply to it, and carry searchable hashtags).
    const outcome = await rt.submit(textPrompt(combined, batch.ids[0]));
    if (outcome === "queued") {
      await send(
        deps,
        chatId,
        `\u{1F4E5} Queued (position ${rt.queueLength})${note} \u2014 I'm still working on the previous task. It'll run next.`,
      );
    }
  } catch (err) {
    log.warn(`submit failed for chat ${chatId}: ${(err as Error).message}`);
    await send(deps, chatId, `\u274C Couldn't start your message: ${(err as Error).message}`);
  }
}

async function send(deps: BotDeps, chatId: number, text: string): Promise<void> {
  try {
    await deps.api.sendMessage(chatId, text);
  } catch {
    /* non-fatal */
  }
}
