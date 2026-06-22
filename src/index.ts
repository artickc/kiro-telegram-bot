/**
 * Kiro Telegram Bot — entry point.
 * Spawns the Kiro ACP agent, starts the Telegram bot, and wires graceful
 * shutdown between them.
 */
import { AcpClient } from "./acp/client.js";
import { createBot } from "./bot/bot.js";
import { loadConfig } from "./config.js";
import { createLogger, enableFileLogging, setLogLevel } from "./logger.js";

async function main(): Promise<void> {
  // Immediate feedback before any async work, so `npm start` shows life at once.
  process.stdout.write("\u{1F916} Kiro Telegram Bot — starting…\n");

  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  enableFileLogging(cfg.logFile);
  const log = createLogger("main");

  log.info("starting Kiro Telegram Bot");
  log.info(`workspace: ${cfg.workspace}`);
  log.info(`kiro-cli:  ${cfg.kiroCliPath}`);
  log.info(`log file:  ${cfg.logFile}`);

  const acp = new AcpClient({
    kiroCliPath: cfg.kiroCliPath,
    workspace: cfg.workspace,
    trustAllTools: cfg.trustAllTools,
    agent: cfg.agent,
    autoRestart: cfg.acpAutoRestart,
    promptIdleTimeoutMs: cfg.promptIdleMs,
  });

  await acp.start();
  const { bot, registry, scheduler, updater } = await createBot(cfg, acp);
  scheduler.start();
  await updater.start();

  let shuttingDown = false;
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down…");
    scheduler.stop();
    updater.stop();
    registry.disposeAll();
    void bot.stop().catch(() => {});
    acp.stop();
    setTimeout(() => process.exit(code), 500);
  };

  acp.on("exit", () => {
    if (!cfg.acpAutoRestart) {
      log.error("kiro-cli ACP exited and auto-restart is off — stopping bot.");
      shutdown(1);
    }
  });
  acp.on("restarted", () => log.info("ACP agent restarted; sessions will re-bind on next message."));

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  process.on("uncaughtException", (err) => log.error("uncaughtException:", err));
  process.on("unhandledRejection", (err) => log.error("unhandledRejection:", err));

  await bot.start({
    onStart: (info) => {
      log.info(`bot online as @${info.username}`);
      process.stdout.write(`\u2705 Online as @${info.username}. Send it a message on Telegram.\n`);
    },
  });
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
