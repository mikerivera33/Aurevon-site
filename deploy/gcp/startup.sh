#!/bin/bash
# Aurevon Discord bot — Google Compute Engine startup script.
#
# Runs as root on every boot (instance metadata key `startup-script`, set by
# provision.sh). Idempotent. It installs Node, writes two systemd units and
# starts them:
#   aurevon-bot.service         node bot.js, restarted on any exit
#   aurevon-bot-deploy.service  polls the bot bundle in Cloud Storage; on a new
#                               upload it re-reads the env secret, installs the
#                               bundle and restarts the bot
# The VM never needs SSH or gcloud: it talks to the metadata server, Cloud
# Storage and Secret Manager over HTTPS with its service account's token.
set -euo pipefail

NODE_MAJOR=22

# 1 GB of RAM: a swap file keeps `npm ci` from being OOM-killed.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
swapon -a || true

# Node.js (official build, checksum verified) in /opt/node.
if ! /opt/node/bin/node -v 2>/dev/null | grep -q "^v${NODE_MAJOR}\."; then
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsS "$base/SHASUMS256.txt")"
  file="$(awk '/linux-x64\.tar\.gz$/ {print $2}' <<<"$sums")"
  tmp="$(mktemp -d)"
  curl -fsSo "$tmp/$file" "$base/$file"
  (cd "$tmp" && grep " $file\$" <<<"$sums" | sha256sum -c -)
  rm -rf /opt/node && mkdir -p /opt/node
  tar -xzf "$tmp/$file" -C /opt/node --strip-components=1
  rm -rf "$tmp"
fi

id aurevon >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin aurevon
mkdir -p /var/lib/aurevon-bot

cat > /usr/local/sbin/aurevon-bot-deploy <<'SCRIPT'
#!/bin/bash
# Poll gs://<bot-bucket>/discord-bot.tgz; install each new generation.
set -uo pipefail
MD=http://metadata.google.internal/computeMetadata/v1
md()    { curl -fsS -H 'Metadata-Flavor: Google' "$MD/$1"; }
token() { md instance/service-accounts/default/token | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'; }
log()   { echo "[deploy] $*"; }

PROJECT="$(md project/project-id)"
BUCKET="$(md instance/attributes/bot-bucket)"
SECRET="$(md instance/attributes/bot-secret)"
# Metadata unreachable at start: exit so systemd (Restart=always) tries again.
[ -n "$PROJECT" ] && [ -n "$BUCKET" ] && [ -n "$SECRET" ] || { log "instance metadata not ready"; exit 1; }
OBJECT="https://storage.googleapis.com/storage/v1/b/$BUCKET/o/discord-bot.tgz"
STATE=/var/lib/aurevon-bot/generation
APP=/opt/aurevon-bot
export PATH=/opt/node/bin:$PATH

install_bundle() { # $1 = generation
  local tok tmp payload
  tok="$(token)" || return 1
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  # The env secret is a dotenv file (KEY=value lines), read fresh on every deploy.
  # Fetched first so a missing secret costs one request, not an npm install.
  payload="$(curl -fsS -H "Authorization: Bearer $tok" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$SECRET/versions/latest:access" \
    | sed -n 's/.*"data": *"\([^"]*\)".*/\1/p')"
  if [ -z "$payload" ]; then log "secret $SECRET has no version yet; add one in Secret Manager"; return 1; fi
  base64 -d <<<"$payload" | tr -d '\r' > "$tmp/env" || return 1

  curl -fsS -H "Authorization: Bearer $tok" -o "$tmp/bot.tgz" "$OBJECT?alt=media&generation=$1" || return 1
  mkdir "$tmp/app" && tar -xzf "$tmp/bot.tgz" -C "$tmp/app" || return 1
  (cd "$tmp/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) || return 1
  install -m 600 -o root -g root "$tmp/env" /etc/aurevon-bot.env

  rm -rf "$APP.previous"
  [ -d "$APP" ] && mv "$APP" "$APP.previous"
  mv "$tmp/app" "$APP" && chown -R root:root "$APP" && chmod -R a+rX "$APP"
  echo "$1" > "$STATE"
  systemctl restart aurevon-bot.service
  log "installed generation $1"
}

while true; do
  gen="$(curl -fsS -H "Authorization: Bearer $(token)" "$OBJECT?fields=generation" 2>/dev/null \
    | sed -n 's/.*"generation": *"\([0-9]*\)".*/\1/p')"
  if [ -n "$gen" ] && [ "$gen" != "$(cat "$STATE" 2>/dev/null)" ]; then
    log "new bundle generation $gen"
    install_bundle "$gen" || log "install of generation $gen failed; keeping the current version"
  fi
  sleep 120
done
SCRIPT
chmod 755 /usr/local/sbin/aurevon-bot-deploy

cat > /etc/systemd/system/aurevon-bot.service <<'UNIT'
[Unit]
Description=Aurevon Discord bot
After=network-online.target
Wants=network-online.target
ConditionPathExists=/etc/aurevon-bot.env
StartLimitIntervalSec=0

[Service]
User=aurevon
Group=aurevon
WorkingDirectory=/opt/aurevon-bot
EnvironmentFile=/etc/aurevon-bot.env
Environment=NODE_ENV=production
ExecStart=/opt/node/bin/node bot.js
Restart=always
RestartSec=5
MemoryMax=700M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/aurevon-bot-deploy.service <<'UNIT'
[Unit]
Description=Aurevon Discord bot deployer (polls Cloud Storage)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/sbin/aurevon-bot-deploy
Restart=always
RestartSec=30
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable aurevon-bot.service aurevon-bot-deploy.service
systemctl start aurevon-bot.service || true   # no-op until the first deploy writes the env file
systemctl restart aurevon-bot-deploy.service
