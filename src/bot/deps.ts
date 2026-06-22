/**
 * Shared dependencies passed to all handlers, plus a small per-chat cache for
 * mapping inline-keyboard buttons back to long values (project paths).
 */
import type { Api } from "grammy";
import type { AcpClient } from "../acp/client.js";
import type { SettingsStore } from "../app/settings-store.js";
import type { AppConfig } from "../config.js";
import type { SttService } from "../app/stt.js";
import type { UsageService } from "../app/usage.js";
import type { ProjectEntry, ProjectManager } from "../projects/manager.js";
import type { SessionMeta } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { TaskRunner } from "../tasks/runner.js";
import type { TaskStore } from "../tasks/store.js";
import type { StatusPanel } from "./menu/status-panel.js";
import type { Ephemeral } from "./menu/ephemeral.js";
import type { RuntimeRegistry } from "./registry.js";
import type { TaskWizard } from "./wizard/task-wizard.js";

export interface BotDeps {
  api: Api;
  cfg: AppConfig;
  acp: AcpClient;
  registry: RuntimeRegistry;
  store: SessionStore;
  projects: ProjectManager;
  menuCache: MenuCache;
  settings: SettingsStore;
  statusPanel: StatusPanel;
  ephemeral: Ephemeral;
  tasks: TaskStore;
  taskRunner: TaskRunner;
  wizard: TaskWizard;
  stt: SttService;
  usage: UsageService;
}

/** Caches the last project list shown per chat for callback resolution. */
export class MenuCache {
  private readonly projectLists = new Map<number, ProjectEntry[]>();
  private readonly sessionLists = new Map<number, { metas: SessionMeta[]; heading: string }>();

  setProjects(chatId: number, list: ProjectEntry[]): void {
    this.projectLists.set(chatId, list);
  }

  getProject(chatId: number, index: number): ProjectEntry | undefined {
    return this.projectLists.get(chatId)?.[index];
  }

  /** The full (sorted) project list, for paging the picker. */
  getProjects(chatId: number): ProjectEntry[] | undefined {
    return this.projectLists.get(chatId);
  }

  /** Remember the session set + heading currently being paged for a chat. */
  setSessions(chatId: number, metas: SessionMeta[], heading: string): void {
    this.sessionLists.set(chatId, { metas, heading });
  }

  getSessions(chatId: number): { metas: SessionMeta[]; heading: string } | undefined {
    return this.sessionLists.get(chatId);
  }
}
