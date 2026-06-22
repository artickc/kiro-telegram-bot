/**
 * /sessions — list recent Kiro sessions and connect to one.
 * /active   — list sessions currently running on this PC.
 * /unwatch  — stop following a live session.
 *
 * Each session is shown as its own card (status, project + path, times, history
 * size, context %), with Connect (resume, or fork if the session is locked/live),
 * 📜 History (static view), and 📡 Watch (live read-only follow) buttons.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { readHistory } from "../../sessions/history.js";
import type { SessionMeta } from "../../sessions/types.js";
import { refreshMenu } from "../menu/refresh.js";
import { showHistory } from "./history.js";
import { buildSessionCard } from "./session-card.js";

/** How many session cards per page. */
const PAGE_SIZE = 10;
const UUID = "([0-9a-fA-F-]{36})";

export async function showSessions(ctx: Context, deps: BotDeps, query?: string): Promise<void> {
  const q = (query ?? "").trim().toLowerCase();
  let metas = deps.store.list(q ? 400 : 200);
  if (q) {
    metas = metas.filter((m) => `${m.title} ${m.cwd} ${m.sessionId}`.toLowerCase().includes(q));
  }
  if (metas.length === 0) {
    await deps.ephemeral.open(ctx);
    await deps.ephemeral.reply(ctx, q ? `No sessions match "${q}".` : "No saved sessions found in ~/.kiro/sessions/cli.");
    return;
  }
  deps.menuCache.setSessions(ctx.chat!.id, metas, q ? `Sessions matching "${q}"` : "Recent sessions");
  await renderSessionPage(ctx, deps, 0);
}

/** Render one page of session cards: header + up to PAGE_SIZE cards + nav footer. */
async function renderSessionPage(ctx: Context, deps: BotDeps, page: number): Promise<void> {
  await deps.ephemeral.open(ctx);
  const cached = deps.menuCache.getSessions(ctx.chat!.id);
  if (!cached) return;
  const { metas, heading } = cached;
  const totalPages = Math.max(1, Math.ceil(metas.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = metas.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);

  const live = slice.filter((m) => m.active).length;
  const liveStr = live ? ` \u00B7 \u{1F7E2} ${live} live` : "";
  const pageStr = totalPages > 1 ? ` \u00B7 page ${p + 1}/${totalPages}` : "";
  await deps.ephemeral.reply(ctx, `\u{1F5C2} ${heading} \u2014 ${metas.length} total${liveStr}${pageStr}`);

  for (const m of slice) {
    const contextPct = deps.acp.metadataFor(m.sessionId)?.contextUsagePercentage;
    const { text, keyboard } = buildSessionCard(m, { contextPct });
    await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
  }

  if (totalPages > 1) {
    const nav = new InlineKeyboard();
    if (p > 0) nav.text("\u25C0 Prev", `sp:${p - 1}`);
    nav.text(`${p + 1}/${totalPages}`, "noop");
    if (p < totalPages - 1) nav.text("Next \u25B6", `sp:${p + 1}`);
    await deps.ephemeral.reply(ctx, `\u{1F4C4} Page ${p + 1}/${totalPages}`, { reply_markup: nav });
  }
}

export function registerSessions(bot: Bot, deps: BotDeps): void {
  bot.command("sessions", (ctx) => showSessions(ctx, deps, ctx.match?.toString()));

  bot.command("active", async (ctx) => {
    const metas = deps.store.listActive();
    if (metas.length === 0) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, "No sessions are currently running on this PC.");
      return;
    }
    deps.menuCache.setSessions(ctx.chat!.id, metas, "Live sessions running now");
    await renderSessionPage(ctx, deps, 0);
  });

  bot.callbackQuery(/^sp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderSessionPage(ctx, deps, Number(ctx.match![1]));
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
    await deps.ephemeral.clear(ctx.chat!.id); // remove the session cards
    const fgCwd = deps.registry.get(ctx.chat!.id).cwd;
    const cwd = meta.cwd || fgCwd;
    const projectName = basename(meta.cwd || fgCwd) || "session";
    const prior = readHistory(deps.store.jsonlPath(id), 24);
    try {
      const { result, alreadyControlled } = await deps.registry
        .controller(ctx.chat!.id)
        .addAttach(id, cwd, projectName, prior);
      await ctx.reply(alreadyControlled ? `\u{1F500} Switched to ${meta.title}` : connectMessage(result, meta));
      await refreshMenu(ctx, deps, `\u{1F4C2} ${meta.title}`);
      await showHistory(deps, ctx.chat!.id, id, meta);
    } catch (err) {
      await ctx.reply(`\u274C Could not connect: ${(err as Error).message}`);
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
