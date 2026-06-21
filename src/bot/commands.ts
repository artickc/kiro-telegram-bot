/**
 * Bot command definitions (for the Telegram command menu) and help text.
 */
export const COMMANDS: { command: string; description: string }[] = [
  { command: "start", description: "Welcome, menu & status panel" },
  { command: "menu", description: "Show the menu keyboard" },
  { command: "projects", description: "Projects: list / search <q> / new <name>" },
  { command: "sessions", description: "List & resume recent sessions" },
  { command: "active", description: "Sessions running now on the PC" },
  { command: "tasks", description: "Manage scheduled tasks" },
  { command: "newtask", description: "Create a scheduled task" },
  { command: "history", description: "Show recent conversation history" },
  { command: "new", description: "Start a fresh session here" },
  { command: "status", description: "Current session, project & queue" },
  { command: "btw", description: "Queue a follow-up: /btw <text>" },
  { command: "flush", description: "Send queued follow-ups now" },
  { command: "queue", description: "Show queued follow-ups" },
  { command: "cancel", description: "Stop the current turn" },
  { command: "unwatch", description: "Stop following a live session" },
  { command: "model", description: "Switch model: /model <id>" },
  { command: "restart", description: "Restart the Kiro agent" },
  { command: "help", description: "Show help" },
];

export const HELP_TEXT = [
  "\u{1F916} Kiro Telegram Bot",
  "Drive Kiro CLI from your phone \u2014 projects, resume, live sessions, diffs.",
  "",
  "HOW IT WORKS",
  "\u2022 Just send a message to chat with Kiro in the current project.",
  "\u2022 While Kiro is working, anything you send is queued and runs",
  "  automatically when the current turn finishes.",
  "",
  "COMMANDS",
  "/projects \u2014 choose which folder Kiro works in",
  "/sessions \u2014 resume one of your recent Kiro sessions",
  "/active \u2014 attach to a session currently running on the PC",
  "/history \u2014 show the latest messages of the current session",
  "/new \u2014 start a brand-new session in the current project",
  "/btw <text> \u2014 add a follow-up to run after the current task",
  "/flush \u2014 run queued follow-ups immediately",
  "/cancel \u2014 stop the current turn",
  "/status \u2014 show session, project and queue size",
].join("\n");
