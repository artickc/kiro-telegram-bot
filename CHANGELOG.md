# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The latest section is published verbatim as the GitHub Release notes by
`.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.

## [1.7.2] - 2026-06-25

The **"steady & solo"** release — a self-computing progress bar that never spams
empty bubbles, a single-instance guard that clears ghost processes, a
path-independent `~/.kiro/tg/` config home, a polished pinned status panel, and
fixes for the false idle-timeout during subagent (translation) work and the bot
rejecting its own pin messages as "Not authorized".

### Added

- **📈 Bot-computed task-progress fallback (`PROGRESS_FALLBACK`).** The
  `{progress: N%}` bar previously depended entirely on the agent emitting the
  marker — and that marker is only an *instruction* the model can ignore, so
  weaker/free models and long, tool-heavy turns often emitted none, leaving the
  bar empty for the whole turn. Now, when `SHOW_PROGRESS` is on but no marker
  arrives, the bot renders a **computed** bar derived from **real activity**
  (completed tool calls, streamed output, elapsed time): it starts low, climbs in
  realistic increments via a saturating curve capped at 90 % while running, and
  fills to 100 % when the turn completes successfully. The estimate is monotonic
  by construction, and the agent's own marker — when present — always takes
  precedence (the fallback stops contributing the moment a real value arrives).
  The bar is only ever **appended to real streamed content** — it never produces
  a standalone/empty bubble — and the live status panel shows it on its own.
  Disable with `PROGRESS_FALLBACK=false`.
- **🏠 Canonical, path-independent config home (`~/.kiro/tg/`).** The `.env`
  (plus `logs/`, `data/`) now lives in `~/.kiro/tg/` by default, so the bot loads
  the **same** configuration no matter which folder you start it from — no more
  "works from this directory, broken from that one". Resolution order is
  `--instance` → `KIRO_TG_DIR` → a `.env` in the current folder (so existing
  per-folder checkouts keep working) → `~/.kiro/tg`. `kiro-tg setup` writes there
  by default, and **`kiro-tg setup --path`** prints the resolved `.env` location.
- **🔒 Single-instance guard, per bot token (`KIRO_TG_SINGLE_INSTANCE`).** On
  startup the bot takes a token-scoped lock under `~/.kiro/tg/locks/`; if a
  still-alive **ghost/duplicate** is already polling Telegram with that token, it
  is terminated (and its child tree on Windows) so the fresh process — with your
  current `.env` — becomes the sole `getUpdates` consumer.

### Changed

- **🧭 Polished status panel.** The pinned status message was redesigned for
  readability: the redundant "Kiro — Status" header is gone, the **progress bar
  is the first line** (so the collapsed pin preview shows how far along the
  current task is), and the cramped space-padded columns are replaced with clean
  emoji-led fields separated by ` | ` across three short lines — activity
  (`state | queue | sessions | watching | subagents`), location
  (`project | session | context`) and config (`agent | reasoning | model`).
  Counters that don't apply (empty queue, single session) are hidden instead of
  shown as `0`.
- **🧹 Progress clears when a turn ends.** The task-progress value is now reset
  when a turn finishes, stops, or errors, so the bar is removed from the status
  panel, session cards and switch messages once the work is done (the finished
  streamed message keeps its own frozen bar as a record).
- **🫥 Status panel only while working.** The pinned status panel now appears
  while a turn is running (or a follow-up is queued) and is **removed when the
  session goes idle**, so the chat stays clean between tasks. The full state is
  still available on demand via **Status** in the menu (`/status`).

### Fixed

- **⛔ Spurious "Not authorized" from the bot's own pin messages.** The auth
  gate replied "⛔ Not authorized" to **every** update whose sender wasn't an
  allowed user — including the bot's **own** service messages. Since the status
  panel is pinned/unpinned, each pin emits a `pinned_message` service update
  authored by the bot, so the gate kept rejecting itself (interleaved with
  normal replies). The gate now ignores updates that aren't a real user action
  (the bot's own/`is_bot` updates, service messages, and updates with no
  `from`), and those pin service messages are deleted on arrival so they no
  longer clutter the chat. Genuine unauthorized users still get one clear reply.
- **⛔ Phantom "Not authorized" from a ghost process.** A leftover bot started
  from another folder kept answering with a stale `.env` (e.g. an outdated
  `ALLOWED_USERS`), rejecting you while the new process couldn't poll (Telegram
  409 Conflict). The single-instance guard above clears the ghost on startup. A
  plain `kiro-tg run` still **yields** to an already-running background service
  rather than fighting it (no restart/kill loop).
- **⏱️ False "No agent activity … giving up" during subagent delegation.** The
  prompt idle-timeout tracked activity per session, but subagents (e.g. parallel
  translation crews) stream on their own session ids, so a main turn that
  delegated heavy work looked "silent" and was killed after ~15 min even though
  the agent was busy — and the next message then collided with the still-running
  turn as `-32603 … dispatch failure`. The watchdog now uses a **process-wide
  activity clock** (any session/subagent stream, metadata, or subagent status
  refreshes it), so a delegating turn stays alive while its subagents work; only
  a genuinely silent agent trips it. When it does fire (idle or the hard cap),
  the agent's turn is now **cancelled** so the session is immediately reusable.
  `dispatch failure` and common connection/stream errors are also now classified
  as **transient**, so they retry/auto-fork instead of surfacing as a dead end.

## [1.7.1] - 2026-06-24

The **"sign in your way"** release — `/reauth` now lets you pick how you log in
(Builder ID, Google, GitHub or IAM Identity Center) on one tidy status card, and
the live task-progress bar climbs steadily instead of appearing only at the end.

### Added

- **🔐 `/reauth` login-method picker.** Re-authentication now opens with a
  **picker** — **Builder ID** (free), **Google**, **GitHub**, or **IAM Identity
  Center** (Pro) — driven on a **single, self-animated status message** with
  inline **Cancel · Retry · Change method · Restart agent** controls, so the chat
  no longer fills with raw spinner frames. **IAM Identity Center** sign-in is now
  fully supported: the bot asks for your **start URL + region** and drives the
  CLI's interactive prompts inside a pseudo-terminal (optional
  `@homebridge/node-pty-prebuilt-multiarch` dependency; a clear message tells you
  to run `npm install` if it's missing). The device-verification URL + code still
  stream to the chat for every method. Power users can skip the picker by passing
  flags directly, e.g. `/reauth --license pro --identity-provider <url> --region <region>`.

### Changed

- **📈 Stricter, steadier task-progress reporting.** The agent instruction behind
  the `{progress: N%}` marker is now far more rigorous: a marker is required on
  **every** message (not only the last), the number must be **computed from real
  step completion** and is **monotonic** (never decreases within a task), and
  **100 %** is reserved for work that is fully complete *and verified*. The bar
  now advances in realistic increments instead of jumping to a value at the very
  end.

### Fixed

- **🔁 `/reauth` agent-restart race** (`agent restart failed: kiro-cli acp exited
  (code null)`). Logging out and restarting could let the **old** agent process's
  exit fail the **new** connection's `initialize` and even trigger a competing
  auto-restart. The ACP client now **fully tears down** the previous process
  (ignoring the exit of a process it has already replaced) **before** spawning a
  fresh one, and `/reauth` takes the agent down and **waits** before logging out —
  so a deliberate restart is clean and the new identity sticks.
- **🪪 Stale identity after re-login.** On logout the bot now also **clears Kiro's
  cached auth token** (`~/.aws/sso/cache/kiro-auth-token.json`), so the next login
  performs a genuine device-flow authentication instead of silently reusing the
  previous account's refreshable token.

## [1.7.0] - 2026-06-23

The **"take control"** release — stop a runaway session by PID, re-authenticate
Kiro from your phone, watch a live task-progress bar, and install on Windows
without admin.

### Added

- **🛑 Kill a session / PID from its card (`/sessions`, `/active`).** Every
  **live** session card now has a **`🛑 Kill · pid N`** button that terminates
  that session's process — and its whole child tree on Windows (`taskkill /T`).
  It's guarded by an inline **confirm** (Kill / Cancel) since it's destructive,
  the bot's **own** agent process is never offered (killing it would take the
  bot down), and the session state is re-read at every step so a session that
  already stopped reports "no longer running" instead of a phantom kill. The
  existing `/killall` (stop every active session at once) is unchanged and now
  shares the same kill logic.
- **🔐 Re-authenticate Kiro from Telegram (`/reauth`).** Logs out
  (`kiro-cli logout`) and starts a fresh **device-flow** login
  (`kiro-cli login --use-device-flow`) — the verification URL + code are
  **streamed into the chat** so you complete it on your own device — then
  **restarts the agent** so it picks up the new credentials. Refused while a
  turn is in flight (logging out would break it) and serialised so two runs
  can't overlap. Pass-through flags are supported, e.g.
  `/reauth --license free` or `/reauth --license pro --region <r> --identity-provider <url>`.
- **📈 Live task-progress bar (`SHOW_PROGRESS`, on by default).** The agent is
  asked to end each message with a `{progress: N%}` marker; the bot **parses and
  hides** it and renders a **green 0–100 % loading bar** (`🟩🟩🟩⬜⬜⬜ 50%`,
  all-green ✅ at 100 %) at the bottom of the **live message**, in the pinned
  **status panel**, and on **`/running` and `/sessions` cards** — so you can see
  how far along the current task is. Markers (and the instruction) are also
  stripped from history, unread replays, previews and fork-priming, so the raw
  plumbing never shows. Disable with `SHOW_PROGRESS=false`.
- **🔀 "Switch to this session" on background pings.** A **`📨 From other
  session`** Done/error notification now carries a **🔀 Switch to this session**
  button that brings that session to the foreground in one tap.

### Changed

- **🪟 Windows install no longer needs admin.** `kiro-tg install` used to fail
  with **`schtasks create failed: ERROR: Access is denied`** for a normal user,
  because registering a **logon-triggered** Scheduled Task is a privileged
  operation. The installer now falls back to a hidden per-user **Startup-folder**
  launcher (runs at logon, **no elevation**) when the task can't be created; an
  **elevated** run still uses the nicer hidden Scheduled Task. `install`,
  `start`, `stop`, `status` and `uninstall` understand both mechanisms, and a
  pre-launch running-check prevents a **double-launch** (two pollers on one bot
  token would otherwise trigger Telegram 409 Conflict).
- **🔕 No interim "Done" ping from a busy background session.** A background
  ("other session") turn that still has **queued follow-ups** no longer pings an
  intermediate "Done" — only the final, queue-empty turn announces completion,
  so a session working through a queue doesn't spam you between steps.

## [1.6.0] - 2026-06-23

The **"always-on & self-healing"** release — the bot keeps itself up to date,
recovers context-full sessions on its own, threads every reply to your prompt,
and keeps the chat tidy while you drive several sessions at once.

### Added

- **🔄 Auto-update (`AUTO_UPDATE`, on by default).** Once an hour the bot makes
  one tiny npm request for the latest version. When a newer one exists **and the
  bot is fully idle** — no chat turn or scheduled task running, and no other
  active Kiro session on the PC — it announces in chat, runs
  `npm install -g kiro-telegram-bot@latest`, restarts, and posts the new
  release's features/fixes **tagged `#update`** so every upgrade is easy to find.
  It never interrupts work, and only acts on a global npm install (a source
  checkout is left to `git`). Tunable via `UPDATE_CHECK_MS`.
- **🏷 Threaded replies + searchable hashtags.** **Every** message of a turn —
  each response bubble, tool call, the retry/fork notices and the Done line — is
  now sent as a **reply to your prompt** (not just the first one), so the whole
  turn is visually threaded to what you asked (your prompt is left untouched).
  **Every message bubble**, including the live thinking/streaming one, ends with
  `#proj_… #sess_…`, so tapping a tag pulls up every message for that project or
  session. (Model and reasoning tags were dropped — they were noisy and rarely
  useful.) Works for text, voice and photo prompts.
- **🔁 Instant fork on a context-full session (`AUTO_FORK_CONTEXT_PCT`, default
  85).** Sending to a session whose context is exhausted used to fail with
  `-32603 … The request was throttled by the service` and then burn the whole
  retry backoff (6s → 12s → 24s → 48s → 60s ≈ 2½ min) before recovering — because
  retrying the same oversized prompt can't succeed. Now, when a prompt fails
  transiently **and** the session's last-known context usage is at/above
  `AUTO_FORK_CONTEXT_PCT` (or the error explicitly names a context-window
  overflow), the bot **skips the retries and forks immediately**: it compacts the
  conversation into a fresh continuation primed with the recent transcript and
  retries your message once. Requires `AUTO_FORK_ON_ERROR`; set the % to `0` to
  disable the early trigger and keep the old retry-then-fork behavior.
- **🗂 Open any folder / safer project creation (`/projects`).** `/projects <path>`
  now opens a session in **any existing folder** — `C:\work\app`, `/home/me/app`,
  `~/app`, even outside your `PROJECT_ROOTS` — and **errors if the path doesn't
  exist** (it's never created). `/projects new <name>` now **errors if the
  project already exists** instead of silently reusing it; otherwise it creates
  the folder and starts a session there. `/project` works as an alias.

### Changed

- **📄 Paginated `/projects` and `/sessions` (10 per page).** Long lists no longer
  flood the chat — the project picker pages in place with **◀ Prev / Next ▶** and
  a `page x/y` indicator, and session cards are shown a page at a time with the
  same nav. Selecting an item still works across pages (absolute indexing).

- **✅ "Done" summaries from other running sessions.** When you drive several
  sessions at once and switch between them, a background session that finishes
  now pings you — clearly marked **`📨 From other session [project · id]`** with
  a **short** file count (`📝 +2 created · ~3 edited · −1 deleted`, or
  `📄 No files modified`). The session you're actively viewing still gets the
  full completion message with the list of changed paths. Toggle with the new
  **`NOTIFY_OTHER_SESSIONS`** env var (default `true`); set it `false` to keep
  background sessions silent (their output still shows when you switch back).
  File operations are tracked for background turns too, so the count is accurate
  regardless of which session you were viewing. **Switching (back) into a
  session also replays its last Done + file summary** at the end of the catch-up
  view (so you see how it ended), and the completion line is now more compact
  and professional — no `end_turn`/`Files:` noise, with project-relative paths.
- **🏷 Clearer skill & MCP tool lines.** Loading a skill now shows
  **`📚 Loaded skill: <name>`** instead of a cryptic `SKILL.md:1` read line, and
  MCP/extension tool calls render as **`🧩 Call MCP <server>: <method>`** (or
  `🧩 Call MCP: <tool>` when the call carries no server name). Built-in
  file/shell tools are never mislabelled.
- **📁 Projects sorted by most-recently-used.** The `/projects` picker now lists
  folders **freshest first** — ranked by the latest of the directory's modified
  time and the newest Kiro session opened in it — so the project you were just
  working in is at the top instead of a fixed alphabetical order.
- **🧭 Redesigned `/running` — one card per session.** Instead of a cramped
  combined list, each controlled session is now its own **card** with
  **🔀 Switch · 📜 History · ✖ Close** buttons, showing its project, status, how
  long ago it was last active, unread count, and a short preview of its first
  prompt (reasoning directive stripped) — so you can tell sessions apart and act
  on each one directly. The foreground session shows ▶️ Current instead of Switch.
- **🧹 Self-cleaning navigation — a tidy history.** Menus, session/project
  cards, pickers and submenus are now **transient**: opening a new surface (or
  acting on one) removes the previous one, and your command / menu-button
  messages are deleted after they're handled. Boundary markers you actually want
  to keep — **🔀 Switched / ✨ New session / 📁 Now working in…**, agent output,
  Done summaries and the pinned status panel — always remain, so the chat reads
  as a clean timeline of what happened, not a pile of menus.

### Fixed

- **👯 Duplicate session cards in `/running`.** Tapping a session twice (or in
  quick succession) could create **two runtimes for the same session** — the
  add-session paths checked "already controlled?" and then `await`ed before
  reserving the runtime, so concurrent taps both passed the check. The runtime
  is now reserved synchronously after the check; restores and persistence dedupe
  by session id; and `/running` prunes any existing duplicate, so the list
  self-heals.
- **🔣 Stray “`” in streamed messages.** An unbalanced/partial code fence in an
  agent message could leave an orphan lone-backtick line that rendered as a
  broken-looking single backtick. Such orphan ` / `` lines are now dropped (real
  triple-backtick fences and inline `code` are untouched).
- **⚡ `/btw` now runs as soon as possible.** Previously `/btw <text>` only ever
  parked the message in the queue — so when the bot was **idle** it sat there
  doing nothing until `/flush` or another message. It now runs **immediately
  when idle**, and when a turn is in flight it's queued and runs **automatically
  the moment that turn finishes** (an in-flight agent turn can't be interrupted).

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

[1.7.1]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.7.1
[1.7.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.7.0
[1.6.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.6.0
[1.5.1]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.5.1
[1.5.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.5.0
[1.4.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.4.0
[1.3.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.3.0
[1.2.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.2.0
[1.1.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.1.0
[1.0.0]: https://github.com/artickc/kiro-telegram-bot/releases/tag/v1.0.0
