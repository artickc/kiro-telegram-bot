/**
 * Document handler — non-image file attachments.
 *
 * The photo handler (registered earlier) claims image documents and passes
 * everything else through to here. We download the file and either:
 *   • inline its text (the common "long message became a .txt" case, plus code,
 *     logs, JSON, CSV, …), truncated to `DOC_MAX_CHARS`, or
 *   • for a binary file, save it under `<dataDir>/downloads` and tell the agent
 *     the path so it can open it with its own tools.
 *
 * Like photos/voice, submissions respect the follow-up queue and any reply
 * context (see reply-context.ts).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Bot, Context } from "grammy";
import { textPrompt } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";
import {
  decodeText,
  formatBinaryFilePrompt,
  formatTextFilePrompt,
  looksLikeText,
} from "../file-ingest.js";
import { extractReplyContext } from "../reply-context.js";

const log = createLogger("document");

export function registerDocuments(bot: Bot, deps: BotDeps): void {
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    // Image documents are downloaded & attached by the photo handler; it only
    // forwards non-image documents here. This guard is a defensive no-op.
    if (doc.mime_type?.startsWith("image/")) return;

    const chatId = ctx.chat.id;
    if (deps.wizard.isActive(chatId)) {
      await ctx.reply("Finish or /cancel the current task wizard before sending files.");
      return;
    }

    const name = doc.file_name?.trim() || "file";
    await ctx.replyWithChatAction("typing").catch(() => {});

    let buf: Buffer;
    try {
      buf = await download(ctx, doc.file_id, deps.cfg.token);
    } catch (e) {
      log.warn(`download failed for "${name}":`, (e as Error).message);
      await ctx.reply(
        `\u274C I couldn't download "${name}": ${(e as Error).message}. ` +
          `(Telegram bots can fetch files up to 20 MB.)`,
      );
      return;
    }

    const caption = ctx.message.caption ?? "";
    const quoted = extractReplyContext(ctx);
    const replyTo = ctx.message.message_id;

    let promptText: string;
    if (looksLikeText(buf, doc.mime_type, name)) {
      const full = decodeText(buf);
      const max = deps.cfg.docMaxChars;
      const truncated = max > 0 && full.length > max;
      const content = truncated ? full.slice(0, max) : full;
      promptText = formatTextFilePrompt(name, content, caption, truncated);
    } else {
      const savedPath = await persistBinary(deps.cfg.dataDir, name, buf).catch((e) => {
        log.warn("saving binary failed:", (e as Error).message);
        return undefined;
      });
      promptText = formatBinaryFilePrompt(name, doc.mime_type, buf.length, caption, savedPath);
    }

    try {
      const rt = deps.registry.get(chatId);
      const outcome = await rt.submit(textPrompt(promptText, replyTo, quoted));
      if (outcome === "queued") {
        await ctx.reply(`\u{1F4E5} Queued "${name}" \u2014 will run after the current task.`);
      }
    } catch (e) {
      log.warn(`submit failed for "${name}":`, (e as Error).message);
      await ctx.reply(`\u274C Couldn't process "${name}": ${(e as Error).message}`);
    }
  });
}

/** Download a Telegram file to a Buffer (subject to the 20 MB Bot API limit). */
async function download(ctx: Context, fileId: string, token: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("no file path returned");
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Persist a binary attachment under `<dataDir>/downloads`, returning its path. */
async function persistBinary(dataDir: string, name: string, buf: Buffer): Promise<string> {
  const dir = join(dataDir, "downloads");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${sanitize(name)}`);
  await writeFile(path, buf);
  return path;
}

/** basename() strips any directory components; then keep only safe characters. */
function sanitize(name: string): string {
  const safe = basename(name).replace(/[^\w.\-]+/g, "_").slice(0, 120);
  return safe.replace(/^\.+/, "") || "file";
}
