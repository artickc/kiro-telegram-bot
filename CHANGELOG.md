# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The latest section is published verbatim as the GitHub Release notes by
`.github/workflows/release.yml` when a `vX.Y.Z` tag is pushed.

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
