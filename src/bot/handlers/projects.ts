/**
 * /projects — browse, search, or create the folder Kiro works in.
 *   /projects              list all projects
 *   /projects <query>      list projects whose name contains <query>
 *   /projects new <name>   create a folder and start a session in it
 * Exposes a reusable project menu used by the menu button and the task wizard.
 */
import { type Context, InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { ProjectEntry } from "../../projects/manager.js";
import type { BotDeps } from "../deps.js";
import { refreshMenu } from "../menu/refresh.js";

const PAGE = 40;

/** Send a project picker. `prefix` is the callback-data prefix (e.g. "proj:"). */
export async function sendProjectMenu(
  ctx: Context,
  deps: BotDeps,
  prefix: string,
  title: string,
  entries?: ProjectEntry[],
): Promise<void> {
  const chatId = ctx.chat!.id;
  const list = sortByRecency(entries ?? deps.projects.list(PAGE), deps);
  deps.menuCache.setProjects(chatId, list);
  if (list.length === 0) {
    await ctx.reply("No matching projects. Try `/projects new <name>` to create one.");
    return;
  }
  const kb = new InlineKeyboard();
  list.forEach((p, i) => kb.text(`\u{1F4C1} ${p.name}`, `${prefix}${i}`).row());
  await ctx.reply(title, { reply_markup: kb });
}

/** Refine project order with Kiro session recency: a project's effective
 *  "last used" is the latest of its directory mtime and the newest session
 *  opened in it, so the project you worked in most recently floats to the top. */
function sortByRecency(entries: ProjectEntry[], deps: BotDeps): ProjectEntry[] {
  const recencyByCwd = new Map<string, number>();
  for (const s of deps.store.list(300)) {
    const key = normCwd(s.cwd);
    if (!key) continue;
    const ms = Date.parse(s.updatedAt);
    if (!Number.isFinite(ms)) continue;
    const prev = recencyByCwd.get(key) ?? 0;
    if (ms > prev) recencyByCwd.set(key, ms);
  }
  return entries
    .map((p) => ({ ...p, lastUsed: Math.max(p.lastUsed, recencyByCwd.get(normCwd(p.path)) ?? 0) }))
    .sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
}

/** Normalise a path for cwd ↔ project matching (case/separator/trailing slash). */
function normCwd(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export async function showProjects(ctx: Context, deps: BotDeps, query?: string): Promise<void> {
  const arg = (query ?? "").trim();

  // Create: /projects new <name>
  const create = /^new\s+(.+)$/i.exec(arg);
  if (create) {
    try {
      const entry = deps.projects.create(create[1]!);
      await deps.registry.controller(ctx.chat!.id).addNew(entry.path, entry.name);
      await refreshMenu(ctx, deps, `\u2705 Created and opened project: ${entry.name}\n${entry.path}`);
    } catch (e) {
      await ctx.reply(`\u274C Could not create project: ${(e as Error).message}`);
    }
    return;
  }

  // Search: /projects <query>
  if (arg) {
    const found = deps.projects.search(arg, PAGE);
    await sendProjectMenu(ctx, deps, "proj:", `Projects matching "${arg}":`, found);
    return;
  }

  await sendProjectMenu(ctx, deps, "proj:", "Choose a project:");
}

export function registerProjects(bot: Bot, deps: BotDeps): void {
  bot.command("projects", (ctx) => showProjects(ctx, deps, ctx.match?.toString()));

  bot.callbackQuery(/^proj:(\d+)$/, async (ctx) => {
    const index = Number(ctx.match![1]);
    const entry = deps.menuCache.getProject(ctx.chat!.id, index);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Selection expired, run /projects again." });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      await deps.registry.controller(ctx.chat!.id).addNew(entry.path, entry.name);
      await ctx.editMessageText(
        `\u2705 Project set: ${entry.name}\n${entry.path}\n\nNew session ready \u2014 send a message.`,
      );
      await refreshMenu(ctx, deps, `\u{1F4C1} Now working in ${entry.name}`);
    } catch (err) {
      await ctx.editMessageText(`\u274C Could not open ${entry.name}: ${(err as Error).message}`);
    }
  });
}
