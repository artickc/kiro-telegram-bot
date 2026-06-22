/**
 * /projects (alias /project) — browse, search, open any folder, or create.
 *   /projects                list/pick projects (freshest first)
 *   /projects <query>        filter projects by name
 *   /projects <path>         open any existing folder (e.g. C:\x, /home/x, ~/x);
 *                            errors if the path doesn't exist (never created)
 *   /projects new <name>     create a folder under the first root + open it;
 *                            errors if it already exists
 * Exposes a reusable project menu used by the menu button and the task wizard.
 */
import { type Context, InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ProjectEntry } from "../../projects/manager.js";
import type { BotDeps } from "../deps.js";
import { refreshMenu } from "../menu/refresh.js";

const PAGE = 10; // projects per page
const FETCH = 300; // how many projects to load before paging

/** Build the inline keyboard for one page of projects + a Prev/Next nav row. */
function projectPage(list: ProjectEntry[], page: number, itemPrefix: string, kind: "p" | "w"): InlineKeyboard {
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const start = p * PAGE;
  const kb = new InlineKeyboard();
  list.slice(start, start + PAGE).forEach((entry, i) => {
    kb.text(`\u{1F4C1} ${entry.name}`, `${itemPrefix}${start + i}`).row();
  });
  if (totalPages > 1) {
    if (p > 0) kb.text("\u25C0 Prev", `pp:${kind}:${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, "noop");
    if (p < totalPages - 1) kb.text("Next \u25B6", `pp:${kind}:${p + 1}`);
  }
  return kb;
}

/** Send a project picker. `prefix` is the callback-data prefix (e.g. "proj:"). */
export async function sendProjectMenu(
  ctx: Context,
  deps: BotDeps,
  prefix: string,
  title: string,
  entries?: ProjectEntry[],
): Promise<void> {
  const chatId = ctx.chat!.id;
  await deps.ephemeral.open(ctx);
  const list = sortByRecency(entries ?? deps.projects.list(FETCH), deps);
  deps.menuCache.setProjects(chatId, list);
  if (list.length === 0) {
    await deps.ephemeral.reply(ctx, "No matching projects. Try `/projects new <name>` to create one.");
    return;
  }
  const kind = prefix === "wiz:proj:" ? "w" : "p";
  await deps.ephemeral.reply(ctx, title, { reply_markup: projectPage(list, 0, prefix, kind) });
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
      await refreshMenu(ctx, deps, `\u2705 Created and opened ${entry.name}\n${entry.path} \u2014 send a message.`);
    } catch (e) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, `\u274C Could not create project: ${(e as Error).message}`);
    }
    return;
  }

  // Switch to an explicit path: /projects C:\path  ·  /projects /home/x  ·  ~/x
  if (arg && looksLikePath(arg)) {
    await openProjectPath(ctx, deps, arg);
    return;
  }

  // Search: /projects <query>
  if (arg) {
    const found = deps.projects.search(arg, FETCH);
    await sendProjectMenu(ctx, deps, "proj:", `Projects matching "${arg}":`, found);
    return;
  }

  await sendProjectMenu(ctx, deps, "proj:", "Choose a project:");
}

/** True when the argument looks like a filesystem path rather than a name. */
function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || /^[a-zA-Z]:/.test(s) || s.startsWith("~");
}

/** Open a session in an explicit folder (any path, even outside PROJECT_ROOTS).
 *  The folder must already exist — we never create it here. */
async function openProjectPath(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const dir = resolvePath(raw);
  if (!deps.projects.isDirectory(dir)) {
    await deps.ephemeral.open(ctx);
    await deps.ephemeral.reply(
      ctx,
      `\u274C Path not found: ${dir}\nI won't create it \u2014 use \`/projects new <name>\` to make a new project.`,
    );
    return;
  }
  await deps.ephemeral.open(ctx);
  const name = basename(dir) || dir;
  try {
    await deps.registry.controller(ctx.chat!.id).addNew(dir, name);
    await refreshMenu(ctx, deps, `\u{1F4C1} Now working in ${name}\n${dir} \u2014 send a message.`);
  } catch (e) {
    await deps.ephemeral.reply(ctx, `\u274C Could not open ${dir}: ${(e as Error).message}`);
  }
}

/** Resolve `~` and normalise a user-supplied path (e.g. `c://lucru` → `C:\lucru`). */
function resolvePath(p: string): string {
  let s = p.trim();
  if (s === "~") s = homedir();
  else if (s.startsWith("~/") || s.startsWith("~\\")) s = join(homedir(), s.slice(2));
  return resolve(s);
}

export function registerProjects(bot: Bot, deps: BotDeps): void {
  bot.command(["projects", "project"], (ctx) => showProjects(ctx, deps, ctx.match?.toString()));

  // Page-indicator buttons do nothing but acknowledge the tap.
  bot.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

  // Project picker pagination: pp:<p|w>:<page> edits the keyboard in place.
  bot.callbackQuery(/^pp:(p|w):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const list = deps.menuCache.getProjects(ctx.chat!.id);
    if (!list) return;
    const kind = ctx.match![1] as "p" | "w";
    const itemPrefix = kind === "w" ? "wiz:proj:" : "proj:";
    const kb = projectPage(list, Number(ctx.match![2]), itemPrefix, kind);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^proj:(\d+)$/, async (ctx) => {
    const index = Number(ctx.match![1]);
    const entry = deps.menuCache.getProject(ctx.chat!.id, index);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: "Selection expired, run /projects again." });
      return;
    }
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id); // remove the project picker
    try {
      await deps.registry.controller(ctx.chat!.id).addNew(entry.path, entry.name);
      await refreshMenu(ctx, deps, `\u{1F4C1} Now working in ${entry.name} \u2014 send a message.`);
    } catch (err) {
      await ctx.reply(`\u274C Could not open ${entry.name}: ${(err as Error).message}`);
    }
  });
}
