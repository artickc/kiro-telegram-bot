/**
 * Status panel — a pinned message that always shows the current project,
 * agent, reasoning effort, model, session and activity. Updated whenever the
 * runtime's state changes. The pinned message id is persisted per chat.
 */
import { type Api, GrammyError } from "grammy";
import { basename } from "node:path";
import { reasoningLabel } from "../../app/reasoning.js";
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
    const project = s.projectName || (s.projectPath ? basename(s.projectPath) : "(none)");
    const session = rt.sessionId ? rt.sessionId.slice(0, 8) : "none";
    const state = rt.isBusy ? "\u23F3 working" : "\u2705 idle";
    const watch = rt.isWatching ? "  \u{1F4E1} watching" : "";
    const meta = rt.contextInfo();
    const ctx = meta?.contextUsagePercentage !== undefined ? `${meta.contextUsagePercentage.toFixed(0)}%` : "\u2014";
    const running = this.registry.controller(chatId).count();
    const sessionLine = running > 1 ? `${session}   \u{1F9ED} ${running} controlled` : session;
    return [
      "\u{1F4CA} Kiro \u2014 Status",
      `\u{1F4C1} Project:   ${project}`,
      `\u{1F916} Agent:     ${s.agent || "default"}`,
      `\u{1F9E0} Reasoning: ${reasoningLabel(s.reasoning)}`,
      `\u{1F9E9} Model:     ${s.model || "default"}`,
      `\u{1F9F5} Session:   ${sessionLine}`,
      `\u{1F4CA} Context:   ${ctx} used`,
      `\u2699\uFE0F State:     ${state}   \u{1F4E5} Queue: ${rt.queueLength}${watch}`,
    ].join("\n");
  }

  /** Refresh (or create + pin) the status message for a chat. */
  async refresh(chatId: number): Promise<void> {
    const text = this.render(chatId);
    const id = this.settings.get(chatId).statusMessageId;

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
