/**
 * /accounts — manage several Kiro logins and switch between them.
 *
 * Kiro keeps a single active login on disk, so this menu lets you snapshot the
 * current login as a named account, import the login from Kiro IDE, and swap
 * the active identity in one tap (which copies the saved token back and
 * restarts the Kiro agent so sessions re-bind under the new account).
 *
 * All logins are process-global (one machine, one active token), so the list is
 * shared across chats. Switching is serialised with the shared ACP agent and
 * refused while a prompt is in flight.
 */
import { type Bot, type Context, InlineKeyboard } from "grammy";
import { AuthService } from "../../app/auth-service.js";
import type { StoredAccount } from "../../app/accounts.js";
import { UNSUPPORTED_LOGIN_HELP } from "../../app/kiro-credentials.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";

const log = createLogger("accounts");

function accountLine(a: StoredAccount, active: boolean): string {
  const mark = active ? "\u2705 " : "\u{1F464} ";
  const type = a.accountType ? ` \u00B7 ${a.accountType}` : "";
  const region = a.region ? ` \u00B7 ${a.region}` : "";
  return `${mark}${a.label}${type}${region}`;
}

/** Build the accounts surface (text + inline keyboard). */
async function view(deps: BotDeps, note?: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const list = deps.accounts.list();
  // The currently active login (may not be saved yet) + whether the CLI accepts it.
  const acct = await deps.usage.account().catch(() => undefined);
  const activeKey = acct?.email || acct?.startUrl;
  const active = activeKey ? list.find((a) => (a.email || a.startUrl) === activeKey)?.id : undefined;
  const loggedIn = await deps.usage.isLoggedIn().catch(() => false);

  const lines = ["\u{1F465} Kiro accounts", ""];
  // Always surface who you're signed in as — including an unsaved login.
  if (activeKey && !active) {
    lines.push(`\u{1F7E2} Signed in as ${activeKey}${loggedIn ? "" : " (kiro-cli: not logged in)"}`);
    if (loggedIn) lines.push("  \u2514 Not saved yet \u2014 tap \u201C\u{1F4BE} Save current login\u201D to keep it.");
    lines.push("");
  }
  if (list.length === 0) {
    lines.push("No saved accounts yet.", "", "Save the current login below, or add one via /reauth.");
  } else {
    for (const a of list) lines.push(accountLine(a, a.id === active));
  }
  const rotate = deps.accounts.autoRotateEnabled();
  lines.push(
    "",
    `\u{1F501} Auto-rotate on errors: ${rotate ? "ON" : "OFF"}`,
    rotate
      ? "  \u2514 If a turn gives up, it cycles through the other accounts once."
      : "  \u2514 Turns stay on the active account.",
  );
  if (note) lines.push("", note);

  const kb = new InlineKeyboard();
  for (const a of list) {
    const sw = a.id === active ? `\u2705 ${trim(a.label)} (active)` : `\u{1F504} ${trim(a.label)}`;
    kb.text(sw, a.id === active ? "acct:noop" : `acct:switch:${a.id}`)
      .text("\u270F\uFE0F", `acct:rename:${a.id}`)
      .text("\u{1F5D1}", `acct:del:${a.id}`)
      .row();
  }
  kb.text("\u{1F4BE} Save current login", "acct:save").text("\u270F\uFE0F Save as\u2026", "acct:saveas").row();
  kb.text("\u{1F4E5} Import Kiro IDE", "acct:import").text("\u{1F511} Log in\u2026", "acct:login").row();
  kb.text(`\u{1F501} Auto-rotate: ${deps.accounts.autoRotateEnabled() ? "ON" : "OFF"}`, "acct:rotate").row();
  kb.text("\u2716 Close", "acct:close");
  return { text: lines.join("\n"), keyboard: kb };
}

function trim(s: string, n = 22): string {
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

export async function showAccounts(ctx: Context, deps: BotDeps): Promise<void> {
  const { text, keyboard } = await view(deps);
  await deps.ephemeral.open(ctx);
  await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

/** Re-render the surface in place after an action. */
async function rerender(ctx: Context, deps: BotDeps, note?: string): Promise<void> {
  const { text, keyboard } = await view(deps, note);
  await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => {});
}

/** Guard: switching/importing touches the shared agent + global credentials. */
function busyReason(deps: BotDeps): string | undefined {
  if (deps.acp.hasInflightPrompt()) return "\u23F3 Kiro is running a turn — try again when idle (or /cancel first).";
  return undefined;
}

export function registerAccounts(bot: Bot, deps: BotDeps): void {
  const auth = new AuthService(deps.cfg.kiroCliPath);
  /** Chats awaiting a typed account name: "save" a new one or "rename" an id. */
  const pending = new Map<number, { mode: "save" | "rename"; id?: string; promptId?: number }>();

  const promptName = async (ctx: Context, mode: "save" | "rename", id?: string): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const ask =
      mode === "save"
        ? "\u270F\uFE0F Send a name for the current login (e.g. \u201CWork\u201D or \u201CPersonal\u201D)."
        : "\u270F\uFE0F Send a new name for this account.";
    const msgId = await deps.ephemeral.reply(ctx, ask);
    pending.set(chatId, { mode, id, promptId: msgId });
  };

  // Capture the typed name. Registered before the prompt catch-all, so a name
  // reply feeds this flow instead of becoming a Kiro prompt.
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const p = pending.get(chatId);
    if (!p) return next();
    const text = ctx.message.text;
    if (text.startsWith("/")) return next(); // a command cancels the naming
    pending.delete(chatId);
    await ctx.deleteMessage().catch(() => {}); // drop the typed name from history
    const name = text.trim().slice(0, 60);
    let note: string;
    try {
      if (p.mode === "rename" && p.id) {
        const meta = deps.accounts.rename(p.id, name);
        note = meta ? `\u270F\uFE0F Renamed to ${meta.label}` : "That account is no longer saved.";
      } else if (!(await deps.usage.isLoggedIn())) {
        note = `\u274C ${UNSUPPORTED_LOGIN_HELP}`;
      } else {
        const acct = await deps.usage.account().catch(() => undefined);
        const saved = await deps.accounts.captureCurrent(acct, name);
        note = `\u{1F4BE} Saved: ${saved.label}`;
      }
    } catch (e) {
      note = `\u274C ${(e as Error).message}`;
    }
    await deps.ephemeral.open(ctx);
    const { text: t, keyboard } = await view(deps, note);
    await deps.ephemeral.reply(ctx, t, { reply_markup: keyboard });
  });

  bot.command("accounts", (ctx) => showAccounts(ctx, deps));

  bot.callbackQuery("acct:noop", (ctx) => ctx.answerCallbackQuery({ text: "Already active" }));

  bot.callbackQuery("acct:saveas", async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptName(ctx, "save");
  });

  bot.callbackQuery("acct:rotate", async (ctx) => {
    const on = deps.accounts.setAutoRotate();
    await ctx.answerCallbackQuery({ text: `Auto-rotate ${on ? "on" : "off"}` });
    await rerender(ctx, deps, on ? "\u{1F501} Auto-rotate enabled." : "\u{1F501} Auto-rotate disabled.");
  });

  bot.callbackQuery(/^acct:rename:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await promptName(ctx, "rename", ctx.match![1]!);
  });

  bot.callbackQuery("acct:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await deps.ephemeral.drop(ctx);
  });

  bot.callbackQuery("acct:save", async (ctx) => {
    if (!(await deps.usage.isLoggedIn())) {
      await ctx.answerCallbackQuery({ text: "kiro-cli isn't logged in", show_alert: true });
      return void rerender(ctx, deps, `\u274C ${UNSUPPORTED_LOGIN_HELP}`);
    }
    try {
      const acct = await deps.usage.account().catch(() => undefined);
      const saved = await deps.accounts.captureCurrent(acct);
      await ctx.answerCallbackQuery({ text: `Saved ${saved.label}` });
      await rerender(ctx, deps, `\u{1F4BE} Saved: ${saved.label}`);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: (e as Error).message.slice(0, 190), show_alert: true });
    }
  });

  bot.callbackQuery("acct:login", async (ctx) => {
    await ctx.answerCallbackQuery();
    await rerender(ctx, deps, "\u{1F511} Run /reauth to log in (Builder ID, Google, GitHub or Organization), then tap \u201CSave current login\u201D.");
  });

  bot.callbackQuery("acct:import", async (ctx) => {
    const reason = busyReason(deps);
    if (reason) return void ctx.answerCallbackQuery({ text: reason, show_alert: true });
    await ctx.answerCallbackQuery({ text: "Importing\u2026" });
    await ctx.editMessageText("\u{1F4E5} Importing your Kiro IDE login\u2026").catch(() => {});
    const res = await auth.importFromKiro();
    if (!res.ok) return void rerender(ctx, deps, `\u274C ${res.error ?? "Import failed."}`);
    try {
      await deps.acp.restart();
    } catch (e) {
      return void rerender(ctx, deps, `\u26A0\uFE0F Imported, but agent restart failed: ${(e as Error).message}`);
    }
    // Confirm kiro-cli actually accepts the imported login before saving it —
    // an org/Microsoft (external_idp) token from Kiro IDE decodes to an email
    // but kiro-cli refuses it, which later shows up as "dispatch failure".
    if (!(await deps.usage.isLoggedIn())) {
      return void rerender(ctx, deps, `\u274C ${UNSUPPORTED_LOGIN_HELP}`);
    }
    const acct = await deps.usage.account().catch(() => undefined);
    let note = "\u2705 Imported the Kiro IDE login.";
    try {
      const saved = await deps.accounts.captureCurrent(acct);
      note = `\u2705 Imported & saved ${saved.label}.`;
    } catch {
      /* capture is best-effort */
    }
    await rerender(ctx, deps, note);
  });

  bot.callbackQuery(/^acct:switch:(.+)$/, async (ctx) => {
    const id = ctx.match![1]!;
    const reason = busyReason(deps);
    if (reason) return void ctx.answerCallbackQuery({ text: reason, show_alert: true });
    await ctx.answerCallbackQuery({ text: "Switching\u2026" });
    try {
      // Don't lose the current login: snapshot it before overwriting (dedupes).
      await deps.accounts.captureCurrent(await deps.usage.account().catch(() => undefined)).catch(() => {});
      const meta = await deps.accounts.switchTo(id);
      await ctx.editMessageText(`\u{1F504} Switching to ${meta.label}\u2026 restarting agent`).catch(() => {});
      await deps.acp.restart();
      const note = (await deps.usage.isLoggedIn())
        ? `\u2705 Now signed in as ${meta.label}. Your session re-binds on the next message.`
        : `\u26A0\uFE0F Switched to ${meta.label}, but kiro-cli reports it's not logged in. ${UNSUPPORTED_LOGIN_HELP}`;
      await rerender(ctx, deps, note);
    } catch (e) {
      log.warn("account switch failed:", (e as Error).message);
      await rerender(ctx, deps, `\u274C ${(e as Error).message}`);
    }
  });

  bot.callbackQuery(/^acct:del:(.+)$/, async (ctx) => {
    const id = ctx.match![1]!;
    const meta = deps.accounts.get(id);
    await deps.accounts.forget(id);
    await ctx.answerCallbackQuery({ text: meta ? `Removed ${meta.label}` : "Removed" });
    await rerender(ctx, deps);
  });
}
