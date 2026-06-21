# 📦 Install guide

Get the Kiro Telegram Bot running in a few minutes. Every
[release](https://github.com/artickc/kiro-telegram-bot/releases) ships a clean
`kiro-telegram-bot-<version>.zip` (no `node_modules`, `.env`, logs or data) that
already contains the **1-click installers** described below.

## Prerequisites

- **Kiro CLI** installed and authenticated — run `kiro-cli chat` once to confirm.
- **Node.js 20+**.
- A **bot token** from [@BotFather](https://t.me/BotFather).
- Your **Telegram user ID** from [@userinfobot](https://t.me/userinfobot).

## 1-click install

1. **Download** the latest `kiro-telegram-bot-<version>.zip` from the
   [Releases](https://github.com/artickc/kiro-telegram-bot/releases) page and
   unzip it (or `git clone` the repo).
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
   user ID(s). Leaving it empty lets *anyone* who finds the bot run commands on
   your machine — don't do that.

## Manual setup

```bash
npm install
npm run setup            # auto-detects kiro-cli + project roots, writes .env
# edit .env: set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
npm start
```

No build step — TypeScript runs directly via `tsx`.

## Run 24/7 as a background service

```bash
npm run install:service     # install + start, enable autostart on boot/login
npm run service -- status   # show install + running state
npm run service -- logs 200 # tail the log file
npm run uninstall:service   # stop + remove
```

The platform is auto-detected: a hidden Scheduled Task on Windows, a systemd
**user** service on Linux, and a launchd LaunchAgent on macOS.

## Configuration

All options live in `.env`. See the **Configuration** table in the
[README](../README.md) for every variable and its default.

## Troubleshooting

- **Bot doesn't respond** — confirm your ID is in `ALLOWED_USERS` and the token
  is correct; check `logs/kiro-telegram-bot.log`.
- **`kiro-cli` not found** — set `KIRO_CLI_PATH` in `.env` to the binary's full
  path.
- **"high volume of traffic" / transient errors** — the bot auto-retries with
  backoff (6s → 60s) and shows the real error; switch model with the 🧩 menu or
  `/model <id>` if a model stays busy.
</content>
