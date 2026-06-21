/**
 * Menu handler — maps the persistent reply-keyboard buttons (matched by emoji
 * prefix for stateful ones) to actions, and provides inline submenus for Agent
 * (real Kiro modes), Reasoning, and Model. Changing a value re-renders the
 * keyboard so its labels always reflect the current state.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { reasoningLabel } from "../../app/reasoning.js";
import { REASONING_LEVELS, type ReasoningEffort } from "../../app/types.js";
import type { BotDeps } from "../deps.js";
import { FIXED, FIXED_LABELS, PREFIX, STATEFUL_RE } from "../menu/keyboard.js";
import { refreshMenu } from "../menu/refresh.js";
import { showProjects } from "./projects.js";
import { showSessions } from "./sessions.js";
import { showTasks } from "./tasks.js";

export function registerMenu(bot: Bot, deps: BotDeps): void {
  // Stateful buttons (Project / Agent / Reasoning / Model) — matched by emoji.
  bot.hears(STATEFUL_RE, async (ctx) => {
    deps.wizard.abort(ctx.chat.id);
    switch (ctx.match[1]) {
      case PREFIX.project:
        return showProjects(ctx, deps);
      case PREFIX.agent:
        return showAgentMenu(ctx, deps);
      case PREFIX.reasoning:
        return showReasoningMenu(ctx, deps);
      case PREFIX.model:
        return showModelMenu(ctx, deps);
    }
  });

  // Fixed action buttons.
  bot.hears(FIXED_LABELS, async (ctx) => {
    deps.wizard.abort(ctx.chat.id);
    const rt = deps.registry.get(ctx.chat.id);
    switch (ctx.message?.text) {
      case FIXED.sessions:
        return showSessions(ctx, deps);
      case FIXED.tasks:
        return showTasks(ctx, deps);
      case FIXED.status:
        await deps.statusPanel.refresh(ctx.chat.id);
        return void ctx.reply(deps.statusPanel.render(ctx.chat.id));
      case FIXED.newSession:
        try {
          await rt.startNewSession(rt.cwd, rt.projectName);
          return refreshMenu(ctx, deps, `\u2728 New session started in ${rt.projectName ?? rt.cwd}`);
        } catch (e) {
          return void ctx.reply(`\u274C ${(e as Error).message}`);
        }
      case FIXED.stop:
        return void ctx.reply((await rt.cancel()) ? "\u23F9 Cancelling\u2026" : "Nothing is running.");
    }
  });

  // ── Agent (real Kiro modes) ─────────────────────────────────────────────
  bot.callbackQuery(/^agent:set:(\d+)$/, async (ctx) => {
    const mode = deps.acp.availableModes[Number(ctx.match![1])];
    if (!mode) return void ctx.answerCallbackQuery({ text: "Expired, tap Agent again." });
    await deps.registry.get(ctx.chat!.id).setAgentPref(mode.id);
    await confirm(ctx, deps, `\u{1F916} Agent: ${mode.name}`);
  });

  // ── Reasoning ──────────────────────────────────────────────────────────────
  bot.callbackQuery(/^reason:(minimal|low|medium|high|max)$/, async (ctx) => {
    const level = ctx.match![1] as ReasoningEffort;
    deps.registry.get(ctx.chat!.id).setReasoningPref(level);
    await confirm(ctx, deps, `\u{1F9E0} Reasoning: ${reasoningLabel(level)}`);
  });

  // ── Model ────────────────────────────────────────────────────────────────
  bot.callbackQuery(/^model:set:(\d+)$/, async (ctx) => {
    const entry = deps.acp.availableModels[Number(ctx.match![1])];
    if (!entry) return void ctx.answerCallbackQuery({ text: "Expired, tap Model again." });
    const res = await deps.registry.get(ctx.chat!.id).setModelPref(entry.modelId);
    await confirm(ctx, deps, res.ok ? `\u{1F9E9} Model: ${entry.name}` : `\u26A0\uFE0F Model set failed: ${res.error}`);
  });
  bot.callbackQuery("model:clear", async (ctx) => {
    await deps.registry.get(ctx.chat!.id).setModelPref("");
    await confirm(ctx, deps, "\u{1F9E9} Model: default");
  });
}

async function confirm(ctx: Context, deps: BotDeps, text: string): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    await ctx.deleteMessage();
  } catch {
    /* ignore */
  }
  await refreshMenu(ctx, deps, text);
}

async function showAgentMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const rt = deps.registry.get(ctx.chat!.id);
  await ensureReady(ctx, rt);
  const modes = deps.acp.availableModes.slice(0, 60);
  if (modes.length === 0) {
    await ctx.reply(`Current agent: ${rt.agent || "default"}\n(No selectable agents reported by Kiro.)`);
    return;
  }
  const kb = new InlineKeyboard();
  modes.forEach((m, i) => kb.text(`${m.id === rt.agent ? "\u2713 " : ""}${m.name}`, `agent:set:${i}`).row());
  await ctx.reply(`Current agent: ${rt.agent || "default"}\nChoose an agent:`, { reply_markup: kb });
}

async function showReasoningMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const rt = deps.registry.get(ctx.chat!.id);
  const kb = new InlineKeyboard();
  REASONING_LEVELS.forEach((l) => kb.text(`${l === rt.reasoning ? "\u2713 " : ""}${reasoningLabel(l)}`, `reason:${l}`));
  await ctx.reply(`Current reasoning: ${reasoningLabel(rt.reasoning)}\nChoose effort:`, { reply_markup: kb });
}

async function showModelMenu(ctx: Context, deps: BotDeps): Promise<void> {
  const rt = deps.registry.get(ctx.chat!.id);
  await ensureReady(ctx, rt);
  const models = deps.acp.availableModels;
  if (models.length === 0) {
    await ctx.reply("No selectable models reported by Kiro yet \u2014 send a message first, then try again.");
    return;
  }
  const current = rt.model || deps.acp.currentModelId;
  const kb = new InlineKeyboard();
  models.forEach((m, i) => kb.text(`${m.modelId === current ? "\u2713 " : ""}${m.name}`, `model:set:${i}`).row());
  kb.text("Default (agent's model)", "model:clear");
  await ctx.reply(`Current model: ${rt.model || "default"}\nChoose a model:`, { reply_markup: kb });
}

/** Ensure a session is live so models/modes are populated; show typing meanwhile. */
async function ensureReady(ctx: Context, rt: { prepare: () => Promise<void> }): Promise<void> {
  try {
    await ctx.replyWithChatAction("typing");
  } catch {
    /* ignore */
  }
  try {
    await rt.prepare();
  } catch {
    /* menu will show whatever is available */
  }
}
