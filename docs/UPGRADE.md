# ⬆️ Upgrade guide

How to update Kiro Telegram Bot to the newest version — for bots installed **via
npm** and for bots installed **without npm** (1-click zip installer or a
git/source checkout).

> **Your config is safe.** Upgrading only replaces the bot's *code*. Your
> settings, credentials and history — `.env`, `data/` (accounts, tasks, ephemeral
> state) and `logs/` — live **outside** the code and are never overwritten by an
> upgrade. Global npm installs keep them in `~/.kiro/tg/`; zip/source installs
> keep them in the bot's folder.

Jump to your install type:

- **[Which install do I have?](#which-install-do-i-have)**
- **[A — Upgrade an npm install](#a--upgrade-an-npm-install)** (auto or manual)
- **[B — Upgrade a 1-click / zip install (no npm)](#b--upgrade-a-1-click--zip-install-no-npm)**
- **[C — Upgrade a git / source install](#c--upgrade-a-git--source-install)**
- **[Restart after upgrading](#restart-after-upgrading)**
- **[Switch a non-npm install over to npm](#switch-a-non-npm-install-over-to-npm)**
- **[Pin a version / roll back](#pin-a-version--roll-back)**
- **[Troubleshooting](#troubleshooting)**

---

## Which install do I have?

Check the current version and where the bot is running from:

```bash
kiro-tg --version 2>/dev/null || npm ls -g kiro-telegram-bot
npm root -g          # global npm modules dir — npm installs live under here
```

- If `kiro-telegram-bot` shows up under `npm root -g`, you have an **npm install** → **[Option A](#a--upgrade-an-npm-install)**.
- If you ran `install.cmd` / `install.sh` from an unzipped release folder, you have a **zip install** → **[Option B](#b--upgrade-a-1-click--zip-install-no-npm)**.
- If you `git clone`d the repo, you have a **source install** → **[Option C](#c--upgrade-a-git--source-install)**.

The latest published version is always on the
[**Releases**](https://github.com/artickc/kiro-telegram-bot/releases) page and in
[CHANGELOG.md](../CHANGELOG.md).

---

## A — Upgrade an npm install

### Automatic (default)

Global npm installs **update themselves**. With `AUTO_UPDATE=true` (the default),
the bot checks npm hourly and, **when it's fully idle** (no turn or task running,
no other active Kiro session), it runs `npm install -g kiro-telegram-bot@latest`,
restarts, and posts the new version's changelog in your chat (tagged `#update`).

You don't have to do anything. To control it, set in your `.env`:

```ini
AUTO_UPDATE=true        # set false to disable self-updates
UPDATE_CHECK_MS=3600000 # how often to check npm (ms)
```

> Auto-update only applies to **global npm** installs. Zip/source checkouts are
> left untouched (see B and C).

### Manual

To upgrade right now (or if you disabled auto-update):

```bash
npm install -g kiro-telegram-bot@latest
```

Then restart the running bot so it loads the new code — see
**[Restart after upgrading](#restart-after-upgrading)**.

Your `.env`, `data/` and `logs/` in `~/.kiro/tg/` (or your `KIRO_TG_DIR`) are
untouched.

---

## B — Upgrade a 1-click / zip install (no npm)

Zip installs **do not auto-update** — you replace the files yourself. The steps
are the same ones you used to install, plus keeping your config. Your `.env`,
`data/` and `logs/` live **inside the bot's folder**, so the goal is to swap the
code while preserving those.

1. **Stop the service** (from your current bot folder):

   ```bash
   npm run service -- stop        # or: kiro-tg stop
   ```

2. **Download** the latest `kiro-telegram-bot-<version>.zip` from the
   [Releases](https://github.com/artickc/kiro-telegram-bot/releases) page and
   **unzip it into a fresh folder**.

3. **Carry your config across** — copy these from the OLD folder into the NEW one:

   - `.env` (your token, allowed users, settings) — **required**
   - `data/` (saved accounts, scheduled tasks) — recommended
   - `logs/` — optional

   **Windows (PowerShell)**

   ```powershell
   Copy-Item ..\old-bot\.env  .\ -Force
   Copy-Item ..\old-bot\data  .\ -Recurse -Force
   ```

   **Linux / macOS**

   ```bash
   cp ../old-bot/.env ./ && cp -r ../old-bot/data ./
   ```

4. **Install deps + service** from the new folder:

   ```bash
   # Windows: .\install.cmd     Linux/macOS: ./install.sh
   # or manually:
   npm install
   npm run install:service      # re-registers the service to the new folder
   ```

   `install.cmd` / `install.sh` detect the copied `.env` and skip re-asking for
   your token.

> **Tip:** upgrading zip installs by hand every release is tedious. Consider
> **[switching to npm](#switch-a-non-npm-install-over-to-npm)** for one-command
> (and automatic) updates.

---

## C — Upgrade a git / source install

A source checkout upgrades with `git`. Your `.env`, `data/` and `logs/` are
git-ignored, so they survive a pull untouched.

```bash
cd kiro-telegram-bot
git pull                 # fetch the latest code
npm install              # pick up any new/updated dependencies
```

Then restart the bot — see **[Restart after upgrading](#restart-after-upgrading)**.

If you're on a fork or have local changes, stash them first (`git stash`), pull,
`npm install`, then `git stash pop`.

---

## Restart after upgrading

New code only takes effect once the running process restarts. Pick what matches
how you run the bot:

| How you run it | Restart command |
|---|---|
| Background service (npm) | `kiro-tg restart` |
| Background service (zip/source) | `npm run service -- restart` |
| Foreground (`kiro-tg run` / `npm start`) | stop with Ctrl-C, start again |

Confirm it's healthy afterwards:

```bash
kiro-tg status         # or: npm run service -- status
kiro-tg logs 100       # or: npm run service -- logs 100
```

> Auto-update (Option A) restarts for you, so a manual restart is only needed
> after a **manual** upgrade.

---

## Switch a non-npm install over to npm

Recommended if you're tired of manual zip upgrades — npm gives you one-command
and automatic updates.

1. **Install the CLI globally:**

   ```bash
   npm install -g kiro-telegram-bot
   ```

2. **Move your config to the canonical home** `~/.kiro/tg/` (run `kiro-tg setup
   --path` to print the exact location), so npm runs find the same settings:

   **Windows (PowerShell)**

   ```powershell
   $dst = "$env:USERPROFILE\.kiro\tg"; New-Item -ItemType Directory -Force $dst | Out-Null
   Copy-Item .\.env "$dst\" -Force
   Copy-Item .\data "$dst\" -Recurse -Force
   ```

   **Linux / macOS**

   ```bash
   mkdir -p ~/.kiro/tg && cp .env ~/.kiro/tg/ && cp -r data ~/.kiro/tg/
   ```

   (Alternatively keep your folder and point at it with `KIRO_TG_DIR`.)

3. **Remove the old service and install the npm one:**

   ```bash
   # in the OLD folder:
   npm run uninstall:service
   # then, from anywhere:
   kiro-tg install
   ```

From now on, upgrade with `npm install -g kiro-telegram-bot@latest` (or let
auto-update handle it).

---

## Pin a version / roll back

Install any specific version (e.g. to roll back a bad upgrade):

```bash
npm install -g kiro-telegram-bot@1.7.2
```

To stop the bot from moving off a pinned version, set `AUTO_UPDATE=false` in
`.env` and restart. For zip/source installs, download the matching release zip or
`git checkout v1.7.2`.

---

## Troubleshooting

- **Still on the old version after upgrading** — you didn't restart. Run
  `kiro-tg restart` (npm) or `npm run service -- restart` (zip/source), then
  check `kiro-tg status`.
- **`kiro-tg: command not found`** — ensure your global npm bin dir is on `PATH`
  (`npm bin -g`), or use `npx kiro-telegram-bot <command>`.
- **Auto-update never fires** — it only runs for **global npm** installs, and
  only while the bot is **idle**; check `AUTO_UPDATE` is `true` and see the log
  (`kiro-tg logs 200`) for a `waiting for idle` line.
- **Lost settings after a zip upgrade** — you upgraded into a new folder without
  copying `.env`/`data/`. Copy them from the old folder (Option B, step 3) and
  restart.
- **Two bots replying / "⛔ Not authorized"** — an old process is still polling.
  The bot is single-instance per token, so just start the new one
  (`kiro-tg restart`) and it terminates the ghost.

---

See also: **[docs/INSTALL.md](./INSTALL.md)** for first-time setup and
[CHANGELOG.md](../CHANGELOG.md) for what changed in each version.
