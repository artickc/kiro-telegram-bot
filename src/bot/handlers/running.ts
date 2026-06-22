/**
 * /running — the sessions this chat controls. Tap one to switch to it; on
 * switch you see a header + the target's unread messages (what happened while
 * you were away) or its recent history the first time.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import type { RunningSession, SwitchResult } from "../chat-controller.js";
import type { BotDeps } from "../deps.js";
import type { HistoryEntry } from "../../sessions/types.js";
import { jsonlMtimeMs, readFirstPrompt } from "../../sessions/history.js";
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
/** Max session cards to send for one /running (avoids flooding the chat). */
const CARD_LIMIT = 12;

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

/** Compact "time ago" label from an elapsed-milliseconds value. */
function timeAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Reduce a stored first prompt to a clean one-liner: drop the leading reasoning
 *  directive and any fork-priming preamble, then collapse whitespace. */
function cleanPrompt(raw: string): string {
  let t = raw.trim().replace(/^\([^)]*\)\s*/, "");
  const marker = "User's new message:";
  const i = t.lastIndexOf(marker);
  if (i !== -1) t = t.slice(i + marker.length);
  return t.replace(/\s+/g, " ").trim();
}

/** Build a rich card (plain text, no MarkdownV2) + buttons for one controlled
 *  session: Switch / History / Close. */
function buildRunningCard(s: RunningSession, deps: BotDeps, now: number): { text: string; kb: InlineKeyboard } {
  const dot = s.foreground ? "\u25B6\uFE0F" : s.busy ? "\u{1F7E0}" : "\u26AA";
  const state = s.foreground ? "foreground" : s.busy ? "working" : "idle";

  let when = "new";
  let prompt = "";
  if (s.sessionId) {
    const path = deps.store.jsonlPath(s.sessionId);
    const mtime = jsonlMtimeMs(path);
    if (mtime) when = timeAgo(now - mtime);
    prompt = cleanPrompt(readFirstPrompt(path));
  }

  const meta = [when, state];
  if (s.busy) meta.push("\u23F3");
  if (s.unread > 0) meta.push(`${s.unread} \u{1F4EC} unread`);

  const lines = [
    `${dot} ${s.projectName}`,
    prompt ? `\u{1F4AC} \u201C${trunc(prompt, 120)}\u201D` : "\u{1F4AC} (no messages yet)",
    `\u{1F552} ${meta.join(" \u00B7 ")}`,
  ];
  if (s.sessionId) lines.push(`\u{1F194} ${s.sessionId.slice(0, 8)}`);

  const kb = new InlineKeyboard();
  if (!s.sessionId) {
    kb.text("\u23F3 starting\u2026", "run:noop");
    return { text: lines.join("\n"), kb };
  }
  if (s.foreground) kb.text("\u25B6\uFE0F Current", "run:noop");
  else kb.text("\u{1F500} Switch", `run:switch:${s.sessionId}`);
  kb.text("\u{1F4DC} History", `hist:${s.sessionId}`).text("\u2716 Close", `run:close:${s.sessionId}`);
  return { text: lines.join("\n"), kb };
}

export async function showRunning(ctx: Context, deps: BotDeps): Promise<void> {
  const list = deps.registry.controller(ctx.chat!.id).list();
  if (list.length === 0) {
    await ctx.reply("No sessions controlled yet. Use \u{1F4C1} Project or /new to start one.");
    return;
  }
  const now = Date.now();
  const shown = list.slice(0, CARD_LIMIT);
  await ctx.reply(`\u{1F9ED} Sessions controlled by this chat (${list.length}) \u2014 tap \u{1F500} Switch on a card:`);
  for (const s of shown) {
    const { text, kb } = buildRunningCard(s, deps, now);
    await ctx.reply(text, { reply_markup: kb });
  }
  if (list.length > shown.length) {
    await ctx.reply(`\u2026and ${list.length - shown.length} more.`);
  }
}

/** Switch the chat to a session and show its summary + unread. */
export async function switchAndShow(ctx: Context, deps: BotDeps, sessionId: string): Promise<void> {
  const res = await deps.registry.controller(ctx.chat!.id).switchTo(sessionId);
  if (!res) {
    await ctx.reply("Session not found (it may have been closed).");
    return;
  }
  await deliverSwitch(ctx, deps, res);
}

export function registerRunning(bot: Bot, deps: BotDeps): void {
  bot.command("running", (ctx) => showRunning(ctx, deps));

  bot.callbackQuery("run:noop", (ctx) => ctx.answerCallbackQuery({ text: "Already in foreground" }));

  bot.callbackQuery(new RegExp(`^run:switch:${UUID}$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await switchAndShow(ctx, deps, ctx.match![1]!);
  });

  bot.callbackQuery(new RegExp(`^run:close:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const ctrl = deps.registry.controller(ctx.chat!.id);
    const proj = ctrl.list().find((s) => s.sessionId === id)?.projectName;
    await ctrl.close(id);
    await ctx.answerCallbackQuery({ text: "Closed" });
    await ctx
      .editMessageText(`\u2716 Closed${proj ? ` ${proj}` : ""} (${id.slice(0, 8)}) \u2014 no longer controlled (still running).`)
      .catch(() => {});
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
