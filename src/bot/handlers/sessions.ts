/**
 * /sessions — list recent Kiro sessions and connect to one.
 * /active   — list sessions currently running on this PC.
 * /unwatch  — stop following a live session.
 *
 * Each session is shown as its own card (status, project + path, times, history
 * size, context %), with Connect (resume, or fork if the session is locked/live),
 * 📜 History (static view), and 📡 Watch (live read-only follow) buttons.
 */
import { type Bot, type Context } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { readHistory } from "../../sessions/history.js";
import type { SessionMeta } from "../../sessions/types.js";
import { refreshMenu } from "../menu/refresh.js";
import { showHistory } from "./history.js";
import { buildSessionCard } from "./session-card.js";

/** How many session cards to send at once (avoids flooding the chat). */
const CARD_LIMIT = 8;
const UUID = "([0-9a-fA-F-]{36})";

export async function showSessions(ctx: Context, deps: BotDeps, query?: string): Promise<void> {
  const q = (query ?? "").trim().toLowerCase();
  let metas = deps.store.list(q ? 200 : 50);
  if (q) {
    metas = metas.filter((m) => `${m.title} ${m.cwd} ${m.sessionId}`.toLowerCase().includes(q));
  }
  if (metas.length === 0) {
    await ctx.reply(q ? `No sessions match "${q}".` : "No saved sessions found in ~/.kiro/sessions/cli.");
    return;
  }
  await sendSessionCards(ctx, deps, metas, q ? `Sessions matching "${q}"` : "Recent sessions");
}

/** Send a header then one rich card per session (active first, capped). */
async function sendSessionCards(
  ctx: Context,
  deps: BotDeps,
  metas: SessionMeta[],
  heading: string,
): Promise<void> {
  const shown = metas.slice(0, CARD_LIMIT);
  const live = shown.filter((m) => m.active).length;
  const ofTotal = metas.length > shown.length ? ` of ${metas.length}` : "";
  const liveStr = live ? ` \u00B7 \u{1F7E2} ${live} live` : "";
  await ctx.reply(`\u{1F5C2} ${heading} \u2014 ${shown.length} shown${ofTotal}${liveStr}`);

  for (const m of shown) {
    const contextPct = deps.acp.metadataFor(m.sessionId)?.contextUsagePercentage;
    const { text, keyboard } = buildSessionCard(m, { contextPct });
    await ctx.reply(text, { reply_markup: keyboard });
  }

  if (metas.length > shown.length) {
    await ctx.reply(`\u2026and ${metas.length - shown.length} more. Use /sessions <query> to filter.`);
  }
}

export function registerSessions(bot: Bot, deps: BotDeps): void {
  bot.command("sessions", (ctx) => showSessions(ctx, deps, ctx.match?.toString()));

  bot.command("active", async (ctx) => {
    const metas = deps.store.listActive();
    if (metas.length === 0) {
      await ctx.reply("No sessions are currently running on this PC.");
      return;
    }
    await sendSessionCards(ctx, deps, metas, "Live sessions running now");
  });

  bot.command("unwatch", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    await ctx.reply(rt.stopWatch() ? "\u{1F6D1} Stopped watching." : "Not watching anything.");
  });

  bot.callbackQuery(new RegExp(`^sess:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const meta = deps.store.get(id);
    if (!meta) {
      await ctx.answerCallbackQuery({ text: "Session not found." });
      return;
    }
    await ctx.answerCallbackQuery();
    const fgCwd = deps.registry.get(ctx.chat!.id).cwd;
    const prior = readHistory(deps.store.jsonlPath(id), 24);
    try {
      const { result, alreadyControlled } = await deps.registry
        .controller(ctx.chat!.id)
        .addAttach(id, meta.cwd || fgCwd, basename(meta.cwd || ""), prior);
      await ctx.editMessageText(alreadyControlled ? `\u{1F500} Switched to ${meta.title}` : connectMessage(result, meta));
      await refreshMenu(ctx, deps, `\u{1F4C2} ${meta.title}`);
      await showHistory(deps, ctx.chat!.id, id, meta);
    } catch (err) {
      await ctx.editMessageText(`\u274C Could not connect: ${(err as Error).message}`);
    }
  });

  bot.callbackQuery(new RegExp(`^hist:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.store.get(id);
    await showHistory(deps, ctx.chat!.id, id, meta);
  });

  bot.callbackQuery(new RegExp(`^watch:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.store.get(id);
    const rt = deps.registry.get(ctx.chat!.id);
    rt.startWatch(deps.store.jsonlPath(id));
    await ctx.reply(
      `\u{1F4E1} Watching live: ${meta?.title ?? id.slice(0, 8)}\nNew activity streams here. Send /unwatch to stop.`,
    );
  });
}

function connectMessage(result: "resumed" | "forked", meta: SessionMeta): string {
  if (result === "resumed") {
    return `\u2705 Resumed: ${meta.title}\n${meta.cwd}\n\nSend a message to continue.`;
  }
  return [
    `\u26A0\uFE0F ${meta.title} is live on your PC right now, so Kiro keeps it locked.`,
    `I opened a linked continuation here in the same project with its recent context.`,
    `${meta.cwd}`,
    ``,
    `Send a message to keep going \u2014 or tap \u{1F4E1} to watch the original live.`,
  ].join("\n");
}
