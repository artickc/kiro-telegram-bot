/**
 * /reauth — re-authenticate Kiro. Instead of always running one provider's
 * device flow, it first shows a login-method picker (Builder ID, Google,
 * GitHub, IAM Identity Center). The chosen method drives a logout → device-flow
 * login → agent restart on a single, self-animated status message. Inline
 * buttons drive the flow:
 *   • Builder ID / Google / GitHub / IAM Identity Center — pick how to log in
 *   • Cancel        — abort the picker or the in-flight logout/login
 *   • Back / Change method — return to the picker
 *   • Retry         — re-run the last method on the same message
 *   • Restart agent — retry just the agent restart after a restart failure
 *
 * Power users can still skip the picker by passing flags directly, e.g.
 * `/reauth --license pro --identity-provider <url> --region <region>`.
 *
 * Guarded: refused while a prompt is in flight (logging out would break the
 * running turn) and serialised per chat so two runs can't overlap.
 */
import type { Bot } from "grammy";
import type { BotDeps } from "../deps.js";
import { type LoginMethod, ReauthController } from "../reauth-controller.js";

export function registerReauth(bot: Bot, deps: BotDeps): void {
  const controller = new ReauthController(
    deps.api,
    deps.acp,
    deps.cfg.kiroCliPath,
    () => deps.usage.account(),
    () => deps.usage.isLoggedIn(),
  );

  // IDC start-URL/region text capture. Registered before the catch-all message
  // handler so the reply feeds the reauth flow instead of becoming a prompt.
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    if (!controller.awaitingIdcInput(chatId)) return next();
    const text = ctx.message.text;
    if (text.startsWith("/")) return next(); // let a command through; picker stays
    await controller.submitIdcInput(chatId, text);
  });

  bot.command("reauth", async (ctx) => {
    if (controller.isBusy(ctx.chat.id)) {
      await ctx.reply("\u{1F510} A re-authentication is already in progress.");
      return;
    }
    const extra = (ctx.match?.toString() ?? "").trim().split(/\s+/).filter(Boolean);
    // Explicit flags skip the picker (advanced / scripted use); otherwise ask.
    if (extra.length > 0) await controller.begin(ctx.chat.id, extra);
    else await controller.chooseMethod(ctx.chat.id);
  });

  bot.callbackQuery(/^reauth:method:(builder|google|github|idc|import|org)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) {
      await controller.pickMethod(chatId, messageId, ctx.match![1] as LoginMethod);
    }
  });

  bot.callbackQuery("reauth:org-check", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking\u2026" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.checkManualLogin(chatId, messageId);
  });

  bot.callbackQuery("reauth:choose-back", async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.chooseMethod(chatId, messageId);
  });

  bot.callbackQuery("reauth:choose-cancel", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.cancelChoice(chatId, messageId);
  });

  bot.callbackQuery("reauth:cancel", async (ctx) => {
    const chatId = ctx.chat?.id;
    const ok = chatId !== undefined && controller.cancel(chatId);
    await ctx.answerCallbackQuery({ text: ok ? "Cancelling\u2026" : "Nothing to cancel" });
  });

  bot.callbackQuery("reauth:retry", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Retrying\u2026" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.retry(chatId, messageId);
  });

  bot.callbackQuery("reauth:restart", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Restarting agent\u2026" });
    const chatId = ctx.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && messageId !== undefined) await controller.restartAgent(chatId, messageId);
  });
}
