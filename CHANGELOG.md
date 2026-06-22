# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The latest section is published verbatim as the GitHub Release notes by
`.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.

## [1.5.1] - 2026-06-22

### Added

- **📦 Install from npm** — the bot is now a published package with a global
  CLI: `npm install -g kiro-telegram-bot` gives you the **`kiro-tg`** command
  (alias `kiro-telegram-bot`). Multiple startup options: `kiro-tg setup`
  (writes `.env` + auto-detects `kiro-cli`), `kiro-tg run` (foreground), and the
  full 24/7 **service** controls — `install · status · logs · stop · restart ·
  uninstall` — auto-detected per platform. Each instance keeps its
  `.env`/`logs/`/`data/` in the **folder you run it from** (resolved from the
  `--instance` the service passes, the launcher's working dir, or the cwd), so a
  global install never writes into `node_modules`. Cloned/zip checkouts behave
  exactly as before. `tsx` moved to runtime deps (still no build step). npm is
  now the **primary** install option in [docs/INSTALL.md](docs/INSTALL.md).

### Fixed

- **🧵 Long messages split by Telegram are now stitched back together** —
  Telegram caps a message at 4096 characters, so a long paste arrives as several
  back-to-back messages. The bot used to treat each part as its own prompt —
  spamming **“Queued (position 1…4)”** and even replying **“Unknown command”**
  when a split landed on a line starting with `/`. Rapid consecutive text
  messages are now **coalesced within a short window into a single prompt** (one
  submission, one confirmation, in order). Tunable via `MESSAGE_BATCH_MS`
  (default `800`; `0` disables). A genuine lone `/typo` still gets the friendly
  “Unknown command” hint, and a failed submit now reports an error instead of
  silently vanishing.

## [1.5.0] - 2026-06-22

The **"mission control"** release — manage the agent's MCP servers and watch
its subagents from Telegram, with quieter notifications and sturdier sessions.

### Added

- **🧩 MCP control (`/mcp`)** — inspect and manage the agent's MCP servers from
  Telegram. Lists every configured server with its **enabled/disabled** state,
  transport (stdio/http) and scope (global/workspace); a **🧪 Health-check**
  runs a real MCP `initialize` handshake against each enabled server and reports
  which **connected** and which **failed (and why)** — connection refused,
  timeout, HTTP status, bad transport, etc. **🔧 Enable/Disable** toggles a
  server's `disabled` flag in its `mcp.json` (other fields preserved) and a
  **🔄 Restart agent** button applies the change immediately. Tunable via
  `MCP_PROBE_TIMEOUT_MS` / `MCP_PROBE_CONCURRENCY`.
- **👥 Subagent visibility** — when the main agent delegates to subagents
  ("crew") and goes quiet while waiting on them, the chat now **shows each
  subagent starting, working and finishing** (via Kiro's
  `_kiro.dev/subagent/list_update`), and the pinned status panel + `/status`
  show a live `🤖 N running · M pending` summary. No more wondering why the
  agent "isn't responding" mid-delegation. Toggle with `SHOW_SUBAGENTS`.
- **🔐 Subagent permission routing** — when permission delegation is active
  (non-trust-all mode), a permission request raised by a **subagent** is now
  routed to its **parent chat** and clearly labelled (`Subagent "X" needs
  approval…`), instead of being auto-decided as unattended.
- **🔕 Quiet notifications (on by default)** — the bot now sends messages
  **silently** (no notification sound) so streaming output and tool/status
  chatter no longer buzz your phone. Only messages that **finish a turn**
  (✅ Done / ⏹ Stopped / ❌ Error), **scheduled-task results**, and **permission
  prompts** ring. Toggle with `QUIET_NOTIFICATIONS` (default `true`).
- **🔐 Session-aware permission prompts** — when a permission request belongs to
  a *background* session, the prompt names it ("Session X needs approval…") and
  adds a **🔀 Switch to it** button next to Allow/Deny (which approve in place,
  without switching). Permission prompts always ring, even in quiet mode.

### Fixed

- **🧭 Session-switch project mismatch** — after switching between controlled
  sessions in different projects, the pinned status panel could show one
  session's **project** next to another's **session id**. The panel now reads
  the project from the live foreground session, and the persisted restore fields
  are kept in sync on every switch, so project and session always match.
- **🔁 Duplicated output after switching to a busy session** — following a busy
  session's in-flight turn live and then sending a new message could echo output
  twice (live stream + tail watcher). The follow-watch is now stopped when a new
  turn starts streaming, and when the followed turn ends.
- **🧷 Lost session (and context) when the agent was waiting on a reply** — if
  the agent ended a turn asking a clarifying question and the ACP process
  restarted during the pause before you answered (it runs 24/7, so transient
  restarts happen), your reply could land in a **brand-new empty session**,
  discarding the whole conversation. Re-binding a session now **retries** the
  flaky load (the agent is usually mid-restart on the first attempt), and if the
  session truly can't be reopened the bot **forks a linked continuation primed
  with the recent transcript** instead of silently starting fresh — and tells
  you it did. Context (including the pending question) survives the restart.

## [1.4.0] - 2026-06-21

The **"work on many sessions at once"** release — drive several Kiro sessions
from a single chat and switch between them, on a redesigned, compact menu.

### Added

- **🧭 Multi-session control & switching (`/running`)** — one chat can now control
  **several Kiro sessions at once**. Start them with 📁 Project / 🆕 New, then tap
  **🧭 Running** (or `/running`) to jump between them. Only the foreground session
  streams live; the rest keep running **quietly** in the background. **Switching
  to a session shows its recent context + every message that arrived while you
  were away** (its "unread", recovered from the session's event log). Each entry
  shows busy/unread badges, and you can close one with ✖ (it isn't killed). The
  controlled set and foreground survive restarts.

### Changed

- **🎛 Redesigned menu — compact, organized, hideable.** The bulky multi-row
  reply keyboard is replaced by a tiny persistent bar (**☰ Menu · 🧭 Running ·
  ⏹ Stop**) plus a clean, grouped **inline menu** opened on demand. The inline
  menu shows the **current agent, model and reasoning** right on their buttons and
  reopens after a change. Hide it with 🙈 and restore with `/menu` or ⌨️ Show bar.
  All live state (project / agent / model / reasoning / context % / controlled
  count) lives in the pinned status panel, keeping the input area uncluttered.

### Verified

- Re-reviewed the transient-error auto-retry path end-to-end (error
  classification, the `6s → 12s → 24s → 48s → 60s` backoff, the "only retry while
  nothing has streamed" guard, and cancellable waits) — confirmed logically
  complete. (Shipped in 1.3.0; carried into this release.)

## [1.3.0] - 2026-06-21

### Added

- **🔁 Transient-error auto-retry with backoff** — when the agent returns a
  transient error (e.g. "high volume of traffic" / `-32603` "Internal error")
  before any output has streamed, the bot retries with an exponential backoff
  (`6s → 12s → 24s → 48s → 60s`) instead of failing immediately. The **real**
  error is shown on every attempt, and a clear summary is sent once retries are
  exhausted. Configurable via `PROMPT_RETRY_ATTEMPTS` (`0` disables; default
  `5`); waits are interruptible with `/cancel`.
- **🪪 Session cards** — `/sessions` and `/active` now render each session as a
  rich card (status dot, project name + full path, created/updated times,
  history size, context-usage %, short id) with **Resume/Continue · History ·
  Watch** buttons, replacing the cramped button grid.
- **📖 Install guide** — new `docs/INSTALL.md`, linked from the README and from
  every GitHub Release.

### Changed

- ACP JSON-RPC errors now surface their **code and data** (and are logged), so
  failures are diagnosable instead of an opaque "Internal error".
- The release workflow always attaches the clean source zip and appends a
  **1-click install** footer (with a link to the install guide) to every
  release's notes.

## [1.2.0] - 2026-06-21

### Added

- **👥 Contributors** — a contrib.rocks avatar wall plus "How to Contribute" and
  "Releasing a New Version" guidance in the README.
- **⭐ Top Contributors** — a curated table highlighting the people who shape the
  project.
- **📊 Stars** — a live star-history chart in the README.
- **🌍 StarMapper** — an interactive world map of the project's stargazers.
- **📦 Release automation** — `.github/workflows/release.yml` builds a clean,
  downloadable source zip and publishes a GitHub Release on every `v*.*.*` tag,
  using this CHANGELOG section as the release notes (auto-generated notes as a
  fallback).
- **🤖 Agent instructions** — a new `AGENTS.md` documenting the architecture,
  conventions, and the batched-PR → conflict-resolve → merge → release workflow.
- **📋 Release checklist** — `docs/ops/RELEASE_CHECKLIST.md` codifies the
  pre-release validation steps.

### Changed

- `CONTRIBUTING.md` now describes the feature-branch → pull-request → release
  workflow and how versioned releases are cut.
- README roadmap updated to mark community/release tooling as shipped.

## [1.1.0] - 2026-06-20

### Added

- Inline approvals (`session/request_permission`): approve / approve-always /
  deny risky tool calls from Telegram buttons.
- Account & context usage via `/usage`, plus a context-usage indicator in the
  status panel.
- Voice messages transcribed to prompts (configurable STT endpoint).

## [1.0.0] - 2026-06-20

### Added

- Initial release: Telegram ⇄ Kiro CLI bridge over the Agent Client Protocol
  (ACP) with projects, resumable and live sessions, queued follow-ups, edit
  diffs, MarkdownV2 rendering, scheduled tasks, multi-image prompts, and a
  cross-platform 24/7 background service.

[1.3.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.3.0
[1.2.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.2.0
[1.1.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.1.0
[1.0.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.0.0
