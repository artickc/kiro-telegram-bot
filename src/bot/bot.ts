/**
 * Assemble the grammY bot: dependencies, middleware, handlers, persistent menu,
 * status panel, and the task scheduler. Handler registration order matters:
 *   auth -> menu buttons -> wizard input -> commands -> photos -> text prompt.
 */
import { Bot } from "grammy";
import type { AcpClient } from "../acp/client.js";
import { SettingsStore } from "../app/settings-store.js";
import { SttService } from "../app/stt.js";
import { UsageService } from "../app/usage.js";
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
import { registerKill } from "./handlers/kill.js";
import { registerMcp } from "./handlers/mcp.js";
import { registerMenu } from "./handlers/menu.js";
import { registerMessages } from "./handlers/message.js";
import { registerPhotos } from "./handlers/photo.js";
import { registerProjects } from "./handlers/projects.js";
import { registerRunning, switchAndShow } from "./handlers/running.js";
import { registerSessions } from "./handlers/sessions.js";
import { registerSystem } from "./handlers/system.js";
import { registerTasks, registerWizardInput } from "./handlers/tasks.js";
import { registerUsage } from "./handlers/usage.js";
import { registerVoice } from "./handlers/voice.js";
import { StatusPanel } from "./menu/status-panel.js";
import { PermissionService } from "./permission-service.js";
import { RuntimeRegistry } from "./registry.js";
import { TaskWizard } from "./wizard/task-wizard.js";

const log = createLogger("bot");

/** Telegram methods that support disable_notification (silenced in quiet mode). */
const SILENCEABLE = new Set([
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendAudio",
  "sendVoice",
  "sendVideo",
  "sendAnimation",
  "sendMediaGroup",
  "copyMessage",
  "forwardMessage",
]);

export interface BotBundle {
  bot: Bot;
  registry: RuntimeRegistry;
  scheduler: Scheduler;
}

export async function createBot(cfg: AppConfig, acp: AcpClient): Promise<BotBundle> {
  const bot = new Bot(cfg.token);

  // Quiet mode (default): silence every outgoing message unless the caller
  // explicitly set disable_notification:false (turn completion, permission
  // prompts, task results). Edits never notify, so they're unaffected.
  if (cfg.quietNotifications) {
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (SILENCEABLE.has(method)) {
        const p = payload as { disable_notification?: boolean };
        if (p.disable_notification === undefined) p.disable_notification = true;
      }
      return prev(method, payload, signal);
    });
  }

  const settings = new SettingsStore(cfg.dataDir);
  const store = new SessionStore(cfg.sessionsDir);
  const registry = new RuntimeRegistry(bot.api, acp, cfg, settings, store);
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
    store,
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
    usage: new UsageService(cfg.kiroCliPath),
  };

  // Inline approvals: when NOT in trust-all mode, Kiro asks before risky tools.
  const permissions = new PermissionService(bot.api, registry);
  acp.permissionHandler = (p) => permissions.handle(p);

  bot.use(createAuthMiddleware(cfg));

  bot.callbackQuery(/^perm:(\d+):(\d+)$/, async (ctx) => {
    const label = permissions.resolveChoice(ctx.match![1]!, Number(ctx.match![2]));
    await ctx.answerCallbackQuery({ text: label ?? "Expired" });
    await ctx.editMessageText(label ? `\u{1F510} ${label}` : "\u{1F510} (expired)").catch(() => {});
  });

  bot.callbackQuery(/^permsw:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const sid = permissions.sessionFor(ctx.match![1]!);
    if (sid) await switchAndShow(ctx, deps, sid);
  });

  registerMenu(bot, deps); // persistent-keyboard buttons (hears)
  registerWizardInput(bot, deps); // wizard text input (before commands)
  registerControl(bot, deps);
  registerProjects(bot, deps);
  registerSessions(bot, deps);
  registerRunning(bot, deps);
  registerHistory(bot, deps);
  registerSystem(bot, deps);
  registerUsage(bot, deps);
  registerKill(bot, deps);
  registerMcp(bot, deps);
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
