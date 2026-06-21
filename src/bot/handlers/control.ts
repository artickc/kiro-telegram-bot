/**
 * Control commands: /start /help /status /new /cancel /btw /flush.
 */
import type { Bot } from "grammy";
import { basename } from "node:path";
import { textPrompt } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { HELP_TEXT } from "../commands.js";
import { compactKeyboard } from "../menu/keyboard.js";
import { refreshMenu } from "../menu/refresh.js";
import { openMainMenu } from "./menu.js";

export function registerControl(bot: Bot, deps: BotDeps): void {
  bot.command("start", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const agent = deps.acp.agentInfo;
    const lines = [
      "\u{1F44B} Welcome! I bridge Telegram to Kiro CLI over ACP.",
      agent?.name ? `Connected to ${agent.name} ${agent.version ?? ""}`.trim() : "",
      "",
      "Tap \u2630 Menu for everything. The pinned panel above always shows your",
      "project, agent, reasoning and model. Just send a message to start.",
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"), { reply_markup: compactKeyboard() });
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("menu", async (ctx) => {
    await openMainMenu(ctx, deps);
    await deps.statusPanel.refresh(ctx.chat.id);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  bot.command("status", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const lines = [
      "\u{1F4CA} Status",
      `Project: ${rt.projectName ?? (basename(rt.cwd) || rt.cwd)}`,
      `Folder: ${rt.cwd}`,
      `Session: ${rt.sessionId ?? "(none yet)"}`,
      `State: ${rt.isBusy ? "\u23F3 working" : "\u2705 idle"}`,
      `Queued follow-ups: ${rt.queueLength}`,
    ];
    await ctx.reply(lines.join("\n"));
  });

  bot.command("new", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    try {
      await deps.registry.controller(ctx.chat.id).addNew(rt.cwd, rt.projectName);
      await refreshMenu(ctx, deps, `\u2728 New session started in ${rt.projectName ?? rt.cwd}`);
    } catch (err) {
      await ctx.reply(`\u274C Could not start session: ${(err as Error).message}`);
    }
  });

  bot.command("cancel", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    const cancelled = await rt.cancel();
    await ctx.reply(cancelled ? "\u23F9 Cancelling current turn\u2026" : "Nothing is running.");
  });

  bot.command("btw", async (ctx) => {
    const text = (ctx.match || "").toString().trim();
    if (!text) {
      await ctx.reply("Usage: /btw <something to do after the current task>");
      return;
    }
    const rt = deps.registry.get(ctx.chat.id);
    rt.enqueue(textPrompt(text));
    await ctx.reply(`\u{1F4E5} Queued (position ${rt.queueLength}). It'll run when the current task finishes.`);
  });

  bot.command("flush", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    if (rt.queueLength === 0) {
      await ctx.reply("Queue is empty.");
      return;
    }
    if (rt.isBusy) {
      await ctx.reply(`\u23F3 ${rt.queueLength} queued \u2014 they'll run automatically when the current turn ends.`);
      return;
    }
    // Idle: drain the queue by submitting an empty trigger that flushes.
    await ctx.reply("\u25B6\uFE0F Running queued follow-ups\u2026");
    const drained = rt.drainQueueToPrompt();
    if (drained) await rt.submit(drained);
  });
}
