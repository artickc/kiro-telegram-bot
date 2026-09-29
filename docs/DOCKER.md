# 🐳 Docker

Run the bot **and Kiro CLI** in one container: nothing to install on the host
except Docker. The image is built from this repository.

**What's inside:** Node.js 24 on Debian 13 (glibc 2.41), the latest stable
**Kiro CLI** at build time (official installer, checksum-verified), `git`,
`ssh`, `curl`, and `tini` as PID 1. Everything runs as the unprivileged `node`
user (uid/gid **1000**). `linux/amd64` and `linux/arm64` are both supported.

## Quick start

```bash
git clone https://github.com/artickc/kiro-telegram-bot.git
cd kiro-telegram-bot
cp .env.example .env          # set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
mkdir -p workspace            # your projects go here (see "Your projects")
docker compose up -d --build
docker compose logs -f        # wait for "✅ Online as @yourbot"
```

Then [log in to Kiro](#log-in-to-kiro) and message your bot.

> [!WARNING]
> **Set `ALLOWED_USERS`.** When it's empty the bot answers *any* Telegram user,
> and it drives an agent that can edit files and run commands in your
> workspace.

## Log in to Kiro

The container starts without a Kiro login. Pick one:

1. **From Telegram (easiest):** send **`/reauth`** and choose Builder ID,
   Google, GitHub or IAM Identity Center. The bot shows a verification link +
   code to approve on your phone; the login is saved in the `kiro-aws` volume.
2. **From a shell:**
   ```bash
   docker compose exec kiro-telegram-bot kiro-cli login --use-device-flow
   docker compose restart
   ```
3. **API key (paid plans: Pro, Pro+, Power):** add `KIRO_API_KEY=ksk_…` to
   `.env`, then `docker compose up -d`. An existing device/browser login takes
   precedence over the key.

**Organization / Microsoft (Entra) accounts** sign in through a browser with a
`localhost` callback, which can't complete inside a container. Log in with
`kiro-cli login` on a machine with a browser, then copy its token in:

```bash
docker compose exec kiro-telegram-bot mkdir -p /home/node/.aws/sso/cache
docker compose cp ~/.aws/sso/cache/kiro-auth-token.json kiro-telegram-bot:/home/node/.aws/sso/cache/
docker compose restart
```

Check who's logged in with `docker compose exec kiro-telegram-bot kiro-cli whoami`.

## Your projects

The container only sees what's mounted at **`/workspace`**; the compose file
maps `./workspace` there, and `/projects` lists its sub-folders. To use an
existing folder, change the mount, e.g. `- ~/code:/workspace`.

The bot runs as **uid 1000**. On Linux the mounted folder must be writable by
that uid: most single-user desktops already use uid 1000 (check with `id -u`);
otherwise grant access, e.g. `setfacl -R -m u:1000:rwX,d:u:1000:rwX ~/code`.

Optional extra mounts (add under `volumes:`), so the agent can use your git
identity and push over SSH:

```yaml
      - ~/.gitconfig:/home/node/.gitconfig:ro
      - ~/.ssh:/home/node/.ssh:ro
```

## Data & volumes

| Volume | Path in the container | Holds |
|---|---|---|
| `kiro-home` | `/home/node/.kiro` | Kiro sessions, agents, settings, MCP config, and the bot's own `data/` + `logs/` (`~/.kiro/tg`) |
| `kiro-aws` | `/home/node/.aws` | Kiro login token (`sso/cache/kiro-auth-token.json`) |
| `kiro-state` | `/home/node/.local/share/kiro-cli` | Kiro CLI local state |
| `./workspace` (bind) | `/workspace` | Your projects |

Named volumes survive `docker compose down` and image rebuilds; only
`docker compose down -v` deletes them.

**MCP servers** are configured as usual in `~/.kiro/settings/mcp.json` (inside
`kiro-home`). Servers launched with `node`/`npx` work out of the box; ones that
need Python/`uvx` or other runtimes need a custom image (`FROM` this one and
`apt-get install` what they need).

## Configuration

All options come from `.env` (see the **Configuration** table in the [README](../README.md)).
The compose file pins the container-specific ones so a `.env` shared with a
host install can't break the container: `KIRO_CLI_PATH`, `KIRO_WORKSPACE`,
`PROJECT_ROOTS` and `AUTO_UPDATE=false`. Don't point `LOG_DIR` / `DATA_DIR` at
host paths in the `.env` you use for Docker.

## Updating

```bash
git pull
docker compose up -d --build
```

The in-app auto-updater is disabled in the container; rebuilding is the update.
Kiro CLI is baked in at build time and Docker caches that layer, so to pull the
newest Kiro CLI release as well:

```bash
docker compose build --build-arg KIRO_CLI_CACHE_BUST="$(date +%s)"
docker compose up -d
```

## Without compose

```bash
docker build -t kiro-telegram-bot .
docker run -d --name kiro-telegram-bot --restart unless-stopped \
  --env-file .env \
  -e KIRO_CLI_PATH=/home/node/.local/bin/kiro-cli \
  -e KIRO_WORKSPACE=/workspace -e PROJECT_ROOTS=/workspace -e AUTO_UPDATE=false \
  -v kiro-home:/home/node/.kiro \
  -v kiro-aws:/home/node/.aws \
  -v kiro-state:/home/node/.local/share/kiro-cli \
  -v "$PWD/workspace:/workspace" \
  kiro-telegram-bot
```

`docker run --rm kiro-telegram-bot help` prints the bot's CLI help; the
`install` / `start` / `stop` service commands don't apply inside a container
(Docker's restart policy is the supervisor).

## Security notes

- **`ALLOWED_USERS`** is the access control. Keep it set.
- `KIRO_TRUST_ALL_TOOLS=true` (the default) lets the agent run tools without
  asking. In the container its reach is the image, the volumes and whatever you
  mount at `/workspace`, but it still has network access. Set it to `false` to
  approve risky tools from Telegram buttons.
- `.env` is never copied into the image (`.dockerignore`); compose passes it at
  runtime. Don't publish images built from a folder containing secrets in other
  files.

## Troubleshooting

- **Logs:** `docker compose logs -f`, or the bot's own log file:
  `docker compose exec kiro-telegram-bot tail -n 100 /home/node/.kiro/tg/logs/kiro-telegram-bot.log`.
- **Kiro CLI install fails during the build:** the installer needs network
  access to `cli.kiro.dev` / `prod.download.cli.kiro.dev` and about 2 GB of free
  temporary space.
- **`409 Conflict` from Telegram:** another process polls the same bot token,
  typically a host install of the bot. Stop it (`kiro-tg stop`) or use a
  different token for the container.
- **"Not logged in" errors on every prompt:** log in (see above), then
  `docker compose restart`.
