# 📦 Install guide

Get the Kiro Telegram Bot running in a few minutes. Pick one of three ways:

- **[Option A — npm (recommended)](#option-a--npm-recommended)** — one command,
  global `kiro-tg` CLI, easiest to update.
- **[Option B — 1-click installer](#option-b--1-click-installer)** — download a
  release zip and double-click the installer.
- **[Option C — manual / from source](#option-c--manual--from-source)** — clone
  the repo (best for contributors).

## Prerequisites

- **Kiro CLI** installed and authenticated — run `kiro-cli chat` once to confirm.
- **Node.js 20+**.
- A **bot token** from [@BotFather](https://t.me/BotFather).
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot).

---

## Option A — npm (recommended)

Install the CLI once, globally. It ships with the `tsx` runtime, so there's no
build step.

```bash
npm install -g kiro-telegram-bot
```

This gives you the **`kiro-tg`** command (alias: `kiro-telegram-bot`). Everything
operates on the **current folder** — your `.env`, `logs/` and `data/` live there,
so keep one folder per bot instance:

```bash
mkdir my-bot && cd my-bot       # a home for this bot's config + logs + data
kiro-tg setup                   # auto-detects kiro-cli, writes ./.env
#   (or pass values directly:  kiro-tg setup <BOT_TOKEN> <YOUR_USER_ID>)
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
kiro-tg run                     # run in the foreground (Ctrl-C to stop)
```

> ⚠️ **Set `ALLOWED_USERS`** in `.env` to your Telegram user ID(s). Empty means
> *anyone* who finds the bot can run commands on your machine.

### Startup options (`kiro-tg <command>`)

| Command | What it does |
|---|---|
| `kiro-tg setup [token] [userId]` | Create/update `.env` in this folder (auto-detects `kiro-cli` + project roots). |
| `kiro-tg run` | Run the bot in the foreground. |
| `kiro-tg install` | Install + start a **24/7 background service** that autostarts on boot/login. |
| `kiro-tg status` | Show install + running state of the service. |
| `kiro-tg logs [n]` | Tail the last `n` log lines (default 100). |
| `kiro-tg stop` / `restart` / `start` | Control the running service. |
| `kiro-tg uninstall` | Stop + remove the background service. |
| `kiro-tg help` | Show all commands. |

The background service is **user-level** and auto-detected per platform — a
hidden Scheduled Task on Windows, a `systemd` **user** service on Linux (with
linger for boot-without-login), and a launchd **LaunchAgent** on macOS. It runs
the bot bound to the folder you installed it from, so its `.env`/`logs`/`data`
stay in that folder.

Update later with `npm install -g kiro-telegram-bot@latest`.

> **Try without installing:** `npx kiro-telegram-bot setup` then
> `npx kiro-telegram-bot run` works too (slower first run).

---

## Option B — 1-click installer

Every [release](https://github.com/artickc/kiro-telegram-bot/releases) ships a
clean `kiro-telegram-bot-<version>.zip` (no `node_modules`, `.env`, logs or data)
that contains the 1-click installers.

1. **Download** the latest `kiro-telegram-bot-<version>.zip` and unzip it (or
   `git clone` the repo).
2. **Run the installer for your OS** from the unzipped folder. It installs
   dependencies, auto-detects `kiro-cli`, writes `.env`, asks for your bot
   token, and optionally sets up the 24/7 background service.

   **Windows** — double-click `install.cmd`, or in a terminal:

   ```powershell
   .\install.cmd
   ```

   **Linux / macOS**:

   ```bash
   chmod +x install.sh && ./install.sh
   ```

3. **Set access control.** Open `.env` and set `ALLOWED_USERS` to your Telegram
   user ID(s).

---

## Option C — manual / from source

Best for contributors (run with auto-reload, no build step).

```bash
git clone https://github.com/artickc/kiro-telegram-bot.git
cd kiro-telegram-bot
npm install
npm run setup            # auto-detects kiro-cli + project roots, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm start                # or: npm run dev  (auto-reload)
```

Run it 24/7 as a background service:

```bash
npm run install:service     # install + start, enable autostart on boot/login
npm run service -- status   # show install + running state
npm run service -- logs 200 # tail the log file
npm run uninstall:service   # stop + remove
```

No build step — TypeScript runs directly via `tsx`.

---

## Configuration

All options live in `.env`. See the **Configuration** table in the
[README](../README.md) for every variable and its default. By default the bot
keeps `.env`, `logs/` and `data/` in the folder you run it from (override log
location with `LOG_DIR` / `LOG_FILE` and data with `DATA_DIR`).

## Troubleshooting

- **Bot doesn't respond** — confirm your ID is in `ALLOWED_USERS` and the token
  is correct; check `logs/kiro-telegram-bot.log` (run `kiro-tg logs`).
- **`kiro-cli` not found** — set `KIRO_CLI_PATH` in `.env` to the binary's full
  path.
- **`kiro-tg: command not found`** — ensure your global npm bin dir is on `PATH`
  (`npm bin -g`), or use `npx kiro-telegram-bot <command>`.
- **"high volume of traffic" / transient errors** — the bot auto-retries with
  backoff (6s → 60s) and shows the real error; switch model with the 🧩 menu or
  `/model <id>` if a model stays busy.
