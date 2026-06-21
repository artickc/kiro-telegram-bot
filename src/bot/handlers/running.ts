/**
 * /running — the sessions this chat controls. Tap one to switch to it; on
 * switch you see a header + the target's unread messages (what happened while
 * you were away) or its recent history the first time.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { SwitchResult } from "../chat-controller.js";
import type { BotDeps } from "../deps.js";
import type { HistoryEntry } from "../../sessions/types.js";
import { refreshMenu } from "../menu/refresh.js";
import { sendMarkdownDoc } from "../telegram-io.js";

const UUID = "([0-9a-fA-F-]{36})";
const ROLE_ICON: Record<string, string> = {
  user: "\u{1F464}",
  assistant: "\u{1F916}",
  tool: "\u{1F527}",
  system: "\u2139\uFE0F",
};
const ENTRY_MAX = 700;

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

function listView(deps: BotDeps, chatId: number): { text: string; kb: InlineKeyboard } {
  const list = deps.registry.controller(chatId).list();
  const kb = new InlineKeyboard();
  if (list.length === 0) {
    return { text: "No sessions controlled yet. Use \u{1F4C1} Project or /new to start one.", kb };
  }
  for (const s of list) {
    const dot = s.foreground ? "\u25B6\uFE0F" : s.busy ? "\u{1F7E0}" : "\u26AA";
    const flags = `${s.busy ? " \u00B7 \u23F3" : ""}${s.unread > 0 ? ` \u00B7 ${s.unread}\u{1F4EC}` : ""}`;
    const label = `${dot} ${trunc(s.projectName, 22)}${flags}`;
    if (!s.sessionId) {
      kb.text(label, "run:noop").row();
      continue;
    }
    kb.text(label, s.foreground ? "run:noop" : `run:switch:${s.sessionId}`).text("\u2716", `run:close:${s.sessionId}`).row();
  }
  return { text: `\u{1F9ED} Sessions controlled by this chat (${list.length}) \u2014 tap to switch:`, kb };
}

export async function showRunning(ctx: Context, deps: BotDeps): Promise<void> {
  const { text, kb } = listView(deps, ctx.chat!.id);
  await ctx.reply(text, { reply_markup: kb });
}

export function registerRunning(bot: Bot, deps: BotDeps): void {
  bot.command("running", (ctx) => showRunning(ctx, deps));

  bot.callbackQuery("run:noop", (ctx) => ctx.answerCallbackQuery({ text: "Already in foreground" }));

  bot.callbackQuery(new RegExp(`^run:switch:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    const res = await deps.registry.controller(ctx.chat!.id).switchTo(ctx.match![1]!);
    if (!res) {
      await ctx.reply("Session not found (it may have been closed).");
      return;
    }
    await deliverSwitch(ctx, deps, res);
  });

  bot.callbackQuery(new RegExp(`^run:close:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Closed" });
    await deps.registry.controller(ctx.chat!.id).close(ctx.match![1]!);
    const { text, kb } = listView(deps, ctx.chat!.id);
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });
}

async function deliverSwitch(ctx: Context, deps: BotDeps, res: SwitchResult): Promise<void> {
  const proj = res.projectName ?? "session";
  const sid = res.sessionId ? res.sessionId.slice(0, 8) : "?";
  if (res.alreadyForeground) {
    await ctx.reply(`You're already on ${proj} (${sid}).`);
    return;
  }
  const working = res.busy ? " \u00B7 \u23F3 still working (live updates follow)" : "";
  await refreshMenu(ctx, deps, `\u{1F500} Switched to ${proj} (${sid})${working}`);

  if (res.unread.length === 0) {
    if (!res.busy) await ctx.reply(res.firstView ? "No earlier messages here." : "\u2705 Nothing new while you were away.");
    return;
  }
  const header = res.firstView
    ? `\u{1F4DC} **Recent history** \u2014 ${proj}`
    : `\u{1F4EC} **${res.unread.length} message(s) while away** \u2014 ${proj}`;
  const body = res.unread.map(fmtEntry).join("\n\n");
  await sendMarkdownDoc(deps.api, ctx.chat!.id, `${header}\n\n${body}`);
}

function fmtEntry(e: HistoryEntry): string {
  const icon = ROLE_ICON[e.role] ?? "\u2022";
  if (e.role === "tool") return `${icon} ${e.tool ? `\`${e.tool}\`` : "tool"}`;
  const text = e.text.length > ENTRY_MAX ? e.text.slice(0, ENTRY_MAX) + " \u2026" : e.text;
  return `${icon} ${text}`;
}
