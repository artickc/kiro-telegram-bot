/**
 * Photo & image-document handler. Downloads images (including multi-image
 * albums / media groups) and submits them to Kiro as ACP image content blocks
 * alongside the caption text.
 */
import type { Bot, Context } from "grammy";
import type { PromptImage } from "../../app/types.js";
import { createLogger } from "../../logger.js";
import type { BotDeps } from "../deps.js";

const log = createLogger("photo");
const GROUP_DEBOUNCE_MS = 900;

interface GroupBuffer {
  chatId: number;
  caption: string;
  images: PromptImage[];
  replyTo?: number;
  timer: NodeJS.Timeout;
}

export function registerPhotos(bot: Bot, deps: BotDeps): void {
  const groups = new Map<string, GroupBuffer>();

  const onMedia = async (ctx: Context, image: PromptImage | undefined, caption: string): Promise<void> => {
    if (!image) return;
    const chatId = ctx.chat!.id;
    const replyTo = ctx.message?.message_id;

    // Don't hijack the task wizard.
    if (deps.wizard.isActive(chatId)) {
      await ctx.reply("Finish or /cancel the current task wizard before sending images.");
      return;
    }

    const groupId = ctx.message?.media_group_id;
    if (!groupId) {
      await submit(deps, chatId, caption, [image], replyTo);
      return;
    }

    // Buffer album items and submit once the group settles.
    const existing = groups.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.images.push(image);
      if (caption) existing.caption = caption;
      existing.timer = setTimeout(() => flush(groups, groupId, deps), GROUP_DEBOUNCE_MS);
    } else {
      groups.set(groupId, {
        chatId,
        caption,
        images: [image],
        replyTo,
        timer: setTimeout(() => flush(groups, groupId, deps), GROUP_DEBOUNCE_MS),
      });
    }
  };

  bot.on("message:photo", async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    const image = largest ? await download(ctx, largest.file_id, "image/jpeg", deps.cfg.token) : undefined;
    await onMedia(ctx, image, ctx.message.caption ?? "");
  });

  bot.on("message:document", async (ctx, next) => {
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) return next(); // let document-handler logic pass
    const image = await download(ctx, doc.file_id, doc.mime_type, deps.cfg.token);
    await onMedia(ctx, image, ctx.message.caption ?? "");
  });
}

async function flush(groups: Map<string, GroupBuffer>, groupId: string, deps: BotDeps): Promise<void> {
  const buf = groups.get(groupId);
  if (!buf) return;
  groups.delete(groupId);
  await submit(deps, buf.chatId, buf.caption, buf.images, buf.replyTo);
}

async function submit(
  deps: BotDeps,
  chatId: number,
  caption: string,
  images: PromptImage[],
  replyTo?: number,
): Promise<void> {
  const rt = deps.registry.get(chatId);
  const outcome = await rt.submit({ text: caption, images, replyTo });
  if (outcome === "queued") {
    await deps.api.sendMessage(
      chatId,
      `\u{1F4E5} Queued ${images.length} image${images.length > 1 ? "s" : ""} \u2014 will run after the current task.`,
    );
  }
}

async function download(
  ctx: Context,
  fileId: string,
  mimeType: string,
  token: string,
): Promise<PromptImage | undefined> {
  try {
    const file = await ctx.api.getFile(fileId);
    if (!file.file_path) return undefined;
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { data: buf.toString("base64"), mimeType };
  } catch (e) {
    log.warn("image download failed:", (e as Error).message);
    return undefined;
  }
}
