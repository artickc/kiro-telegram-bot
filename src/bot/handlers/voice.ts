/**
 * Voice & audio handler — transcribes Telegram voice notes / audio files to
 * text (any language) and submits them as prompts.
 */
import type { Bot, Context } from "grammy";
import { textPrompt } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";

const log = createLogger("voice");

export function registerVoice(bot: Bot, deps: BotDeps): void {
  const handle = async (ctx: Context, fileId: string, mime: string, name: string): Promise<void> => {
    const chatId = ctx.chat!.id;
    if (deps.wizard.isActive(chatId)) {
      await ctx.reply("Finish or /cancel the task wizard before sending voice.");
      return;
    }
    if (!deps.stt.enabled) {
      await ctx.reply("\u{1F399} Voice isn't configured. Set STT_API_URL (and STT_API_KEY) in .env.");
      return;
    }
    await ctx.replyWithChatAction("typing").catch(() => {});
    try {
      const bytes = await download(ctx, fileId, deps.cfg.token);
      if (!bytes) throw new Error("could not download the audio");
      const text = await deps.stt.transcribe(bytes, mime, name);
      if (!text) {
        await ctx.reply("\u{1F399} I couldn't make out any speech.");
        return;
      }
      await ctx.reply(`\u{1F399} \u201C${text}\u201D`);
      const rt = deps.registry.get(chatId);
      const outcome = await rt.submit(textPrompt(text, ctx.message?.message_id));
      if (outcome === "queued") await ctx.reply("\u{1F4E5} Queued \u2014 will run after the current task.");
    } catch (e) {
      log.warn("voice failed:", (e as Error).message);
      await ctx.reply(`\u274C Voice transcription failed: ${(e as Error).message}`);
    }
  };

  bot.on("message:voice", (ctx) => handle(ctx, ctx.message.voice.file_id, ctx.message.voice.mime_type || "audio/ogg", "voice.ogg"));
  bot.on("message:audio", (ctx) => handle(ctx, ctx.message.audio.file_id, ctx.message.audio.mime_type || "audio/mpeg", ctx.message.audio.file_name || "audio.mp3"));
  bot.on("message:video_note", (ctx) => handle(ctx, ctx.message.video_note.file_id, "video/mp4", "note.mp4"));
}

async function download(ctx: Context, fileId: string, token: string): Promise<Buffer | undefined> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) return undefined;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
