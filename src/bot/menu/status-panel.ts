/**
 * Status panel — a pinned message that always shows the current project,
 * agent, reasoning effort, model, session and activity. Updated whenever the
 * runtime's state changes. The pinned message id is persisted per chat.
 */
import { type Api, GrammyError } from "grammy";
import { basename } from "node:path";
import { reasoningLabel } from "../../app/reasoning.js";
import { progressBar } from "../../render/progress.js";
import type { SettingsStore } from "../../app/settings-store.js";
import { createLogger } from "../../logger.js";
import type { RuntimeRegistry } from "../registry.js";

const log = createLogger("status-panel");

export class StatusPanel {
  constructor(
    private readonly api: Api,
    private readonly settings: SettingsStore,
    private readonly registry: RuntimeRegistry,
  ) {}

  /** Build the status text from settings + live runtime state. */
  render(chatId: number): string {
    const s = this.settings.get(chatId);
    const rt = this.registry.get(chatId);
    // Project comes from the live foreground runtime — not the persisted single
    // session — so it always matches the session id shown below, even right
    // after switching between controlled sessions in different projects.
    const project = rt.projectName || (rt.cwd ? basename(rt.cwd) : "(none)");
    const session = rt.sessionId ? rt.sessionId.slice(0, 8) : "none";
    const meta = rt.contextInfo();
    const ctxPct = meta?.contextUsagePercentage;
    const running = this.registry.controller(chatId).count();
    const subagents = this.registry.subagentSummaryForChat(chatId);
    const progress = rt.taskProgress;

    const SEP = " | "; // pipe delimiter between inline fields
    const lines: string[] = [];

    // 1) Progress first — only while a turn is live (cleared when it ends), so
    //    the collapsed pin preview shows how far along the current task is.
    if (progress !== undefined) lines.push(`\u{1F4C8} ${progressBar(progress)}`);

    // 2) Activity: state + only the counters that currently apply.
    const activity: string[] = [rt.isBusy ? "\u23F3 Working" : "\u2705 Idle"];
    if (rt.queueLength > 0) activity.push(`\u{1F4E5} ${rt.queueLength} queued`);
    if (running > 1) activity.push(`\u{1F9ED} ${running} sessions`);
    if (rt.isWatching) activity.push("\u{1F4E1} watching");
    if (subagents) activity.push(`\u{1F465} ${subagents}`);
    lines.push(activity.join(SEP));

    // 3) Where: project | session | context usage.
    const loc = [`\u{1F4C1} ${project}`, `\u{1F9F5} ${session}`];
    if (ctxPct !== undefined) loc.push(`\u{1F4CA} ${ctxPct.toFixed(0)}% context`);
    lines.push(loc.join(SEP));

    // 4) How: agent | reasoning | model.
    lines.push([`\u{1F916} ${s.agent || "default"}`, `\u{1F9E0} ${reasoningLabel(s.reasoning)}`, `\u{1F9E9} ${s.model || "default"}`].join(SEP));

    return lines.join("\n");
  }

  /** Refresh (or create + pin) the status message for a chat. */
  async refresh(chatId: number): Promise<void> {
    const rt = this.registry.get(chatId);
    const id = this.settings.get(chatId).statusMessageId;

    // The pinned panel exists only while there's live work — a running turn or a
    // queued follow-up about to run. When the session is idle there's nothing to
    // show, so remove the panel to keep the chat clean. (The on-demand /status
    // still renders full state when explicitly requested.)
    const active = rt.isBusy || rt.queueLength > 0;
    if (!active) {
      if (id) await this.remove(chatId, id);
      return;
    }

    const text = this.render(chatId);
    if (id) {
      try {
        await this.api.editMessageText(chatId, id, text);
        return;
      } catch (err) {
        if (err instanceof GrammyError && /not modified/i.test(err.description)) return;
        log.debug("status edit failed, recreating:", (err as Error).message);
      }
    }
    await this.create(chatId, text);
  }

  /** Remove the pinned panel (unpin + delete) and forget its id. */
  private async remove(chatId: number, id: number): Promise<void> {
    this.settings.update(chatId, { statusMessageId: undefined });
    try {
      await this.api.deleteMessage(chatId, id); // deleting a pinned message also unpins it
    } catch {
      try {
        await this.api.unpinChatMessage(chatId, id);
      } catch {
        /* best-effort */
      }
    }
  }

  private async create(chatId: number, text: string): Promise<void> {
    try {
      const msg = await this.api.sendMessage(chatId, text, { disable_notification: true });
      this.settings.update(chatId, { statusMessageId: msg.message_id });
      await this.api.pinChatMessage(chatId, msg.message_id, { disable_notification: true });
    } catch (err) {
      log.debug("status create/pin failed:", (err as Error).message);
    }
  }
}
