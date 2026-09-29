/**
 * /export — download the current session's full transcript as a document:
 * `/export` (Markdown, default) or `/export txt` (plain text).
 */
import { type Bot, InputFile } from "grammy";
import { basename } from "node:path";
import { createLogger } from "../../logger.js";
import { sessionHashtags } from "../../render/hashtags.js";
import {
  describeStats,
  renderTranscript,
  type TranscriptFormat,
  type TranscriptInfo,
  transcriptFilename,
  transcriptStats,
  transcriptTitle,
} from "../../render/transcript.js";
import { readTranscript, TRANSCRIPT_MAX_BYTES } from "../../sessions/transcript.js";
import type { TranscriptTurn } from "../../sessions/types.js";
import type { BotDeps } from "../deps.js";

const log = createLogger("export");

/** Telegram's caption limit (characters). */
const CAPTION_MAX = 1024;
const USAGE = "Usage: /export \u2014 Markdown (.md) \u00B7 /export txt \u2014 plain text (.txt)";

export function registerExport(bot: Bot, deps: BotDeps): void {
  bot.command("export", async (ctx) => {
    const format = parseExportFormat(ctx.match);
    if (!format) {
      await ctx.reply(USAGE);
      return;
    }
    const rt = deps.registry.get(ctx.chat.id);
    const sessionId = rt.sessionId;
    if (!sessionId) {
      await ctx.reply("No active session. Use /sessions or send a message first.");
      return;
    }

    const { turns, truncated } = readTranscript(deps.store.jsonlPath(sessionId));
    if (turns.length === 0) {
      await ctx.reply("No history found for this session yet.");
      return;
    }

    const meta = deps.store.get(sessionId);
    const info: TranscriptInfo = {
      sessionId,
      title: meta?.title,
      cwd: meta?.cwd || rt.cwd,
      exportedAt: new Date(),
      truncated,
      maxLabel: `${Math.round(TRANSCRIPT_MAX_BYTES / (1024 * 1024))} MB`,
    };
    const doc = renderTranscript(turns, info, format);
    const file = new InputFile(Buffer.from(doc, "utf-8"), transcriptFilename(info, format));
    const tags = rt.tags || sessionHashtags({ cwd: info.cwd, sessionId });

    await ctx.replyWithChatAction("upload_document").catch(() => {});
    try {
      await ctx.replyWithDocument(file, { caption: exportCaption(info, turns, tags) });
    } catch (e) {
      log.warn("export failed:", (e as Error).message);
      await ctx.reply(`\u274C Export failed: ${(e as Error).message}`);
    }
  });
}

/** `""`/`md`/`markdown` → md · `txt`/`text`/`plain` → txt · anything else → undefined. */
export function parseExportFormat(arg: string | undefined): TranscriptFormat | undefined {
  const a = (arg ?? "").trim().toLowerCase().replace(/^\./, "");
  if (a === "" || a === "md" || a === "markdown") return "md";
  if (a === "txt" || a === "text" || a === "plain") return "txt";
  return undefined;
}

/** "📜 Transcript — <title> (<project>)" + counts + tags, within Telegram's limit
 *  (the title is what gets shortened). */
export function exportCaption(info: TranscriptInfo, turns: TranscriptTurn[], tags: string): string {
  const project = info.cwd ? ` (${basename(info.cwd)})` : "";
  const note = info.truncated ? "\n\u26A0\uFE0F Long session \u2014 only the most recent part is included." : "";
  const tail = `\n${describeStats(transcriptStats(turns))}${note}${tags ? `\n\n${tags}` : ""}`;
  let head = `\u{1F4DC} Transcript \u2014 ${transcriptTitle(info)}${project}`;
  if (head.length + tail.length > CAPTION_MAX) head = `${head.slice(0, Math.max(0, CAPTION_MAX - tail.length - 1))}\u2026`;
  return `${head}${tail}`;
}
