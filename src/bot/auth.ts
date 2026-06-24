/**
 * Authorization middleware: restricts the bot to ALLOWED_USERS when configured.
 */
import type { Context, NextFunction } from "grammy";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";

const log = createLogger("auth");

export function createAuthMiddleware(cfg: AppConfig) {
  const allowAll = cfg.allowedUsers.size === 0;
  if (allowAll) {
    log.warn("ALLOWED_USERS is empty — the bot will respond to ANY Telegram user.");
  }

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const from = ctx.from;
    // Only a genuine USER action is subject to (and worth replying to) the auth
    // gate. Ignore everything else silently — most importantly the bot's OWN
    // updates: the status panel being pinned/unpinned emits a service message
    // whose `from` is THIS bot (is_bot), and replying "⛔ Not authorized" to
    // that (or to any service/no-`from` update) spammed the chat with false
    // rejections. Real unauthorized users still get one clear reply below.
    if (!from || from.is_bot) return;
    const m = ctx.message ?? ctx.editedMessage;
    if (m && (m.pinned_message || m.new_chat_members || m.left_chat_member)) return;

    const userId = String(from.id);
    if (allowAll || cfg.allowedUsers.has(userId)) {
      await next();
      return;
    }
    log.warn(`blocked unauthorized user ${userId}`);
    if (ctx.chat) {
      await ctx.reply("\u26D4 Not authorized. Ask the bot owner to add your Telegram ID.");
    }
  };
}
