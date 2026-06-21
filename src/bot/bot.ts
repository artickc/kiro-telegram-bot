/**
 * Assemble the grammY bot: dependencies, middleware, handlers, persistent menu,
 * status panel, and the task scheduler. Handler registration order matters:
 *   auth -> menu buttons -> wizard input -> commands -> photos -> text prompt.
 */
import { Bot } from "grammy";
import type { AcpClient } from "../acp/client.js";
import { SettingsStore } from "../app/settings-store.js";
import { SttService } from "../app/stt.js";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { ProjectManager } from "../projects/manager.js";
import { SessionStore } from "../sessions/store.js";
import { TaskRunner } from "../tasks/runner.js";
import { Scheduler } from "../tasks/scheduler.js";
import { TaskStore } from "../tasks/store.js";
import { createAuthMiddleware } from "./auth.js";
import { COMMANDS } from "./commands.js";
import { type BotDeps, MenuCache } from "./deps.js";
import { registerControl } from "./handlers/control.js";
import { registerHistory } from "./handlers/history.js";
import { registerMenu } from "./handlers/menu.js";
import { registerMessages } from "./handlers/message.js";
import { registerPhotos } from "./handlers/photo.js";
import { registerProjects } from "./handlers/projects.js";
import { registerSessions } from "./handlers/sessions.js";
import { registerSystem } from "./handlers/system.js";
import { registerTasks, registerWizardInput } from "./handlers/tasks.js";
import { registerVoice } from "./handlers/voice.js";
import { StatusPanel } from "./menu/status-panel.js";
import { RuntimeRegistry } from "./registry.js";
import { TaskWizard } from "./wizard/task-wizard.js";

const log = createLogger("bot");

export interface BotBundle {
  bot: Bot;
  registry: RuntimeRegistry;
  scheduler: Scheduler;
}

export async function createBot(cfg: AppConfig, acp: AcpClient): Promise<BotBundle> {
  const bot = new Bot(cfg.token);

  const settings = new SettingsStore(cfg.dataDir);
  const registry = new RuntimeRegistry(bot.api, acp, cfg, settings);
  const tasks = new TaskStore(cfg.dataDir);
  const taskRunner = new TaskRunner(bot.api, acp);
  const wizard = new TaskWizard(tasks);
  const statusPanel = new StatusPanel(bot.api, settings, registry);
  registry.setRefresher((chatId) => void statusPanel.refresh(chatId));

  const deps: BotDeps = {
    api: bot.api,
    cfg,
    acp,
    registry,
    store: new SessionStore(cfg.sessionsDir),
    projects: new ProjectManager(cfg.projectRoots),
    menuCache: new MenuCache(),
    settings,
    statusPanel,
    tasks,
    taskRunner,
    wizard,
    stt: new SttService({
      apiUrl: cfg.sttApiUrl,
      apiKey: cfg.sttApiKey,
      model: cfg.sttModel,
      language: cfg.sttLanguage,
    }),
  };

  bot.use(createAuthMiddleware(cfg));

  registerMenu(bot, deps); // persistent-keyboard buttons (hears)
  registerWizardInput(bot, deps); // wizard text input (before commands)
  registerControl(bot, deps);
  registerProjects(bot, deps);
  registerSessions(bot, deps);
  registerHistory(bot, deps);
  registerSystem(bot, deps);
  registerTasks(bot, deps);
  registerPhotos(bot, deps); // photos & image documents
  registerVoice(bot, deps); // voice / audio -> transcription -> prompt
  registerMessages(bot, deps); // catch-all text prompt — keep last

  bot.catch((err) => {
    log.error("unhandled bot error:", err.error instanceof Error ? err.error.message : err.error);
  });

  try {
    await bot.api.setMyCommands(COMMANDS);
  } catch (e) {
    log.warn("setMyCommands failed:", (e as Error).message);
  }

  return { bot, registry, scheduler: new Scheduler(tasks, taskRunner) };
}
