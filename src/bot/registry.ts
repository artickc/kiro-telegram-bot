/**
 * Tracks one ChatController per Telegram chat (each controlling one or more
 * sessions). `get(chatId)` returns the chat's foreground SessionRuntime so the
 * existing handlers keep operating on "the current session".
 */
import type { Api } from "grammy";
import type { AcpClient } from "../acp/client.js";
import type { SettingsStore } from "../app/settings-store.js";
import type { AppConfig } from "../config.js";
import type { SessionStore } from "../sessions/store.js";
import { ChatController } from "./chat-controller.js";
import type { SessionRuntime } from "./session-runtime.js";

export class RuntimeRegistry {
  private readonly controllers = new Map<number, ChatController>();
  private refresher: ((chatId: number) => void) | undefined;

  constructor(
    private readonly api: Api,
    private readonly acp: AcpClient,
    private readonly cfg: AppConfig,
    private readonly settings: SettingsStore,
    private readonly store: SessionStore,
  ) {}

  setRefresher(fn: (chatId: number) => void): void {
    this.refresher = fn;
  }

  controller(chatId: number): ChatController {
    let c = this.controllers.get(chatId);
    if (!c) {
      c = new ChatController(this.api, chatId, this.acp, this.cfg, this.settings, this.store, (id) =>
        this.refresher?.(id),
      );
      this.controllers.set(chatId, c);
    }
    return c;
  }

  /** The chat's foreground runtime (backward-compatible with existing handlers). */
  get(chatId: number): SessionRuntime {
    return this.controller(chatId).foreground();
  }

  disposeAll(): void {
    for (const c of this.controllers.values()) c.dispose();
    this.controllers.clear();
  }

  /** Find the chat that currently controls a given session id. */
  findChatBySession(sessionId: string): number | undefined {
    for (const [chatId, c] of this.controllers) {
      if (c.findBySession(sessionId)) return chatId;
    }
    return undefined;
  }
}
