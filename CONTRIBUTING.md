# Contributing

Thanks for your interest in improving the Kiro Telegram Bot!

## Development setup

```bash
git clone https://github.com/artickc/kiro-telegram-bot.git
cd kiro-telegram-bot
npm install
cp .env.example .env   # add your TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm run dev            # auto-reload on changes
```

No build step is required — the project runs TypeScript directly via `tsx`.

## Before opening a pull request

- `npm run typecheck` must pass with no errors.
- Keep files focused and under ~500 lines; prefer small modules.
- Match the existing style (ESM imports with `.js` specifiers, named exports).
- Don't introduce new dependencies without a good reason.
- Never commit `.env`, tokens, logs, or generated launcher files.

## Project layout

See the "Project layout" section in the [README](./README.md). In short:

- `src/acp` — Agent Client Protocol client and transport
- `src/sessions` — session discovery, history, live tail
- `src/render` — Markdown → Telegram MarkdownV2, diffs, tool formatting
- `src/bot` — grammY bot, handlers, per-chat runtime
- `src/service` — cross-platform daemon install (Windows/Linux/macOS)

## Branch, PR & release workflow

Work is delivered as **batches of small, focused branches opened as pull
requests**, then merged and shipped together in the **next versioned release**.
Please don't push feature work straight to `main`.

1. Branch off the latest `main`, one logical change per branch
   (`git checkout -b feat/<topic>`).
2. Implement it and make sure `npm run typecheck` passes.
3. Open a PR to `main` (`gh pr create --base main --fill`). CI runs `typecheck`.
4. Several ready PRs are merged in sequence as a batch.
5. If a branch falls behind, update it from `main`
   (`git merge origin/main`), resolve conflicts keeping both sides' intent,
   re-run `typecheck`, then merge.

### How releases are cut

Releases are automated. Pushing a `vX.Y.Z` tag runs
`.github/workflows/release.yml`, which type-checks, builds a clean downloadable
zip, and publishes a GitHub Release using the matching `CHANGELOG.md` section as
the notes:

```bash
# update CHANGELOG.md, then:
npm version minor          # patch | minor | major
git push --follow-tags
```

See [`docs/ops/RELEASE_CHECKLIST.md`](./docs/ops/RELEASE_CHECKLIST.md) for the
full pre-release checklist.

## Reporting bugs

Open an issue using the bug template. Include your OS, Node version, Kiro CLI
version (`kiro-cli --version`), and relevant log lines from
`logs/kiro-telegram-bot.log` (redact any secrets).

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).
