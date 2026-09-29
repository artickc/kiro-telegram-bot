# syntax=docker/dockerfile:1
#
# Kiro Telegram Bot with Kiro CLI preinstalled — one container runs the bot and
# its `kiro-cli acp` agent. Quick start (see docs/DOCKER.md):
#
#   cp .env.example .env        # set TELEGRAM_BOT_TOKEN and ALLOWED_USERS
#   docker compose up -d --build
#
# Debian 13 (trixie) ships glibc 2.41, which the Kiro CLI glibc builds need on
# both architectures (x86_64 >= 2.34, aarch64 >= 2.39).
FROM node:24-trixie-slim

# Runtime tools the agent commonly shells out to, plus the installer's needs
# (curl, unzip, sha256sum from coreutils) and tini as a proper PID 1 (reaps the
# processes kiro-cli spawns and forwards SIGTERM for a clean shutdown).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git openssh-client procps tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /app /workspace \
 && chown node:node /app /workspace

# Everything below runs as the unprivileged `node` user (uid/gid 1000).
USER node
ENV HOME=/home/node \
    PATH=/home/node/.local/bin:$PATH

# Kiro CLI -> ~/.local/bin via the official installer (detects arch + glibc and
# verifies the download checksum). Change KIRO_CLI_CACHE_BUST to force a fresh
# download of the latest release on rebuild.
ARG KIRO_CLI_CHANNEL=stable
ARG KIRO_CLI_CACHE_BUST=0
RUN curl -fsSL https://cli.kiro.dev/install -o /tmp/kiro-install.sh \
 && bash /tmp/kiro-install.sh --channel "$KIRO_CLI_CHANNEL" \
 && rm -f /tmp/kiro-install.sh \
 && kiro-cli --version

# Pre-create the persisted dirs so named volumes inherit `node` ownership.
RUN mkdir -p /home/node/.kiro/tg /home/node/.aws /home/node/.local/share/kiro-cli

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force
COPY --chown=node:node . .

# KIRO_TG_DIR: the bot's .env (optional — compose passes env vars), logs/, data/
# and locks live in the persisted ~/.kiro volume. The image is updated by
# rebuilding, so the in-app npm auto-updater is off.
ENV NODE_ENV=production \
    KIRO_TG_DIR=/home/node/.kiro/tg \
    KIRO_WORKSPACE=/workspace \
    PROJECT_ROOTS=/workspace \
    KIRO_TG_SUPERVISED=1 \
    AUTO_UPDATE=false

VOLUME ["/home/node/.kiro", "/home/node/.aws", "/home/node/.local/share/kiro-cli"]

ENTRYPOINT ["tini", "--", "node", "--import", "tsx", "src/cli.ts"]
CMD ["run"]
