/**
 * Per-chat settings persistence (project, agent, model, reasoning, pinned
 * status message id). Backed by a single JSON file so state survives restarts.
 */
import { join } from "node:path";
import { JsonStore } from "./json-store.js";
import { type ChatSettings, defaultSettings } from "./types.js";

type SettingsMap = Record<string, ChatSettings>;

export class SettingsStore {
  private readonly store: JsonStore<SettingsMap>;

  constructor(dataDir: string) {
    this.store = new JsonStore<SettingsMap>(join(dataDir, "settings.json"), {});
  }

  get(chatId: number): ChatSettings {
    const existing = this.store.get()[String(chatId)];
    return existing ?? defaultSettings();
  }

  update(chatId: number, patch: Partial<ChatSettings>): ChatSettings {
    const key = String(chatId);
    const next = { ...this.get(chatId), ...patch };
    this.store.update((m) => {
      m[key] = next;
    });
    return next;
  }

  /** All chat ids that have interacted (for broadcast announcements). */
  chatIds(): number[] {
    return Object.keys(this.store.get())
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }
}
