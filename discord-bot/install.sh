#!/usr/bin/env bash
# OnYourSite Discord-Bot – Installation auf einem Linux-Server.
#
# Zwei Arten, den Bot laufen zu lassen:
#   --service  als Systemdienst mit Node.js – z. B. auf demselben Server wie die Webseite (server/install.sh)
#   --docker   als Docker-Container – z. B. auf einem eigenen kleinen Server nur für den Bot
#
#   sudo bash install.sh              Einrichten oder Einstellungen ändern (fragt nach der Art)
#   sudo bash install.sh --update     Neue Version übernehmen, Einstellungen bleiben
#
# Die Einstellungen (Token, IDs, Geheimnis) liegen in einer Datei, die nur root lesen kann – nie im Webordner
# und nie im Docker-Image. Beim erneuten Aufruf behält Enter die bisherigen Werte.
# server/install.sh übergibt OYS_SITE_URL und OYS_BOT_SECRET, dann muss nichts in config.php kopiert werden.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
SRC=$(pwd)

NAME=onyoursite-bot
APP_DIR=/opt/onyoursite-bot
SERVICE_ENV=/etc/onyoursite-bot.env
UNIT=/etc/systemd/system/onyoursite-bot.service

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
# Frage mit Vorgabe; endet die Eingabe (kein Terminal), gilt die Vorgabe
choose() {
  local reply
  read -rp "  $1 " reply || reply=""
  printf '%s' "${reply:-$2}"
}
# Node.js ab 18.17 (das brauchen discord.js und undici)
node_ok() {
  "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 18 || (a === 18 && b >= 17) ? 0 : 1)' 2>/dev/null
}

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "Please run this as root."
  exec sudo bash "$0" "$@"
fi

UPDATE=0
MODE=""
for arg in "$@"; do
  case $arg in
    --update) UPDATE=1 ;;
    --service) MODE=service ;;
    --docker) MODE=docker ;;
    *) fail "Unknown option: $arg (use --service, --docker or --update)" ;;
  esac
done

# Art: was schon installiert ist – sonst fragen
if [ -z "$MODE" ]; then
  if [ -f "$UNIT" ]; then
    MODE=service
  elif [ -f "$SRC/.env" ] && [ -f "$SRC/docker-compose.yml" ]; then
    MODE=docker
  elif [ "$UPDATE" = 1 ]; then
    fail "The bot isn’t installed yet. Run: sudo bash $SRC/install.sh"
  else
    bold "How should the bot run?"
    info "1) As a system service with Node.js   (recommended – also on the same server as the website)"
    info "2) In Docker"
    case "$(choose "Choose 1 or 2 [1]:" 1)" in
      1) MODE=service ;;
      2) MODE=docker ;;
      *) fail "Please choose 1 or 2." ;;
    esac
  fi
fi
if [ "$MODE" = service ]; then ENV_FILE=$SERVICE_ENV; else ENV_FILE=$SRC/.env; fi

# ---------------------------------------------------------------
if [ "$MODE" = service ]; then
  bold "1/4  Node.js"
  { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; } || fail "This server doesn’t use systemd – install with --docker instead."
  NODE=""
  for candidate in "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/local/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ] && node_ok "$candidate"; then NODE=$candidate; break; fi
  done
  if [ -z "$NODE" ]; then
    [ "$UPDATE" = 0 ] || fail "Node.js 18.17 or newer is missing."
    command -v apt-get >/dev/null 2>&1 || fail "Install Node.js 22 (nodejs.org) and run this again."
    case "$(choose "Node.js 18.17 or newer is missing. Install Node.js 22 now (from deb.nodesource.com)? [Y/n]" y)" in
      [nN]*) fail "Install Node.js 22 and run this again." ;;
    esac
    command -v curl >/dev/null 2>&1 || fail "curl is missing – install it first (apt install curl)."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
    NODE=$(command -v node || true)
    if [ -z "$NODE" ] || ! node_ok "$NODE"; then fail "Node.js couldn’t be installed."; fi
  fi
  NODE_BIN=$(dirname "$NODE")
  [ -x "$NODE_BIN/npm" ] || command -v npm >/dev/null 2>&1 || fail "npm is missing next to $NODE."
  info "Node.js $("$NODE" --version) ($NODE)"
else
  bold "1/4  Docker"
  if ! command -v docker >/dev/null 2>&1; then
    [ "$UPDATE" = 0 ] || fail "Docker is not installed."
    case "$(choose "Docker is not installed. Install it now with the official script from get.docker.com? [Y/n]" y)" in
      [nN]*) fail "Install Docker and run this again – or use --service." ;;
    esac
    command -v curl >/dev/null 2>&1 || fail "curl is missing – install it first (e.g. apt install curl)."
    curl -fsSL https://get.docker.com | sh
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    fail "Docker Compose is missing (e.g. apt install docker-compose-plugin)."
  fi
  docker info >/dev/null 2>&1 || fail "Docker is installed but not running (systemctl start docker)."
  info "$(docker --version)"
  case "$SRC" in
    /var/www/*|*/httpdocs/*|*/public_html/*)
      info "Note: this is inside a website folder, and the settings file (.env) would be stored here."
      info "The .htaccess blocks it, but --service keeps the settings in /etc instead." ;;
  esac
fi

# ---------------------------------------------------------------
bold "2/4  Settings"
NEW_SECRET=""
# Bisheriger Wert aus der Einstellungsdatei (ohne sie auszuführen)
current() {
  if [ -f "$ENV_FILE" ]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; fi
}

# ask KEY "Frage" Art [Vorgabe] – Art: id (Pflicht), opt (Discord-ID oder leer), token, secret, url, seconds
ask() {
  local key=$1 label=$2 kind=$3 def=${4:-} cur value hint
  cur=$(current "$key")
  [ -n "$cur" ] && def=$cur
  while true; do
    if [ "$kind" = token ] || [ "$kind" = secret ]; then
      hint=""; [ -n "$def" ] && hint=" (Enter = keep the current one)"
      read -rsp "  $label$hint: " value || fail "The input ended – please run install.sh in a terminal."
      echo
    else
      read -rp "  $label${def:+ [$def]}: " value || fail "The input ended – please run install.sh in a terminal."
    fi
    value=${value:-$def}
    value=$(printf '%s' "$value" | tr -d '[:space:]')
    case $kind in
      id)      [[ $value =~ ^[0-9]{15,22}$ ]] && break; info "  Please paste a Discord ID (digits only – right-click → Copy ID)." ;;
      opt)     [[ -z $value || $value =~ ^[0-9]{15,22}$ ]] && break; info "  Please paste a Discord ID or leave it empty." ;;
      token)   [[ $value =~ ^[A-Za-z0-9._-]{50,}$ ]] && break; info "  That doesn’t look like a bot token (Developer Portal → Bot → Reset Token)." ;;
      secret)  [[ ${#value} -ge 32 && $value =~ ^[A-Za-z0-9._~+/=-]+$ ]] && break; info "  At least 32 characters, letters and digits." ;;
      url)     [[ $value =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] && break; info "  The address of the website with https://, e.g. https://on-your.site" ;;
      seconds) [[ $value =~ ^[0-9]+$ ]] && [ "$value" -ge 5 ] && [ "$value" -le 300 ] && break; info "  A number from 5 to 300." ;;
    esac
  done
  printf -v "VAL_$key" '%s' "$value"
}

if [ "$UPDATE" = 1 ]; then
  [ -f "$ENV_FILE" ] || fail "There are no settings yet. Run: sudo bash $SRC/install.sh"
  info "Keeping the settings in $ENV_FILE"
else
  info "From the Discord Developer Portal (discord.com/developers/applications) → your application:"
  info "  Bot token: tab Bot → Reset Token.  Application ID: tab General Information."
  info "  The Client Secret is NOT needed – don’t enter it anywhere."
  info "Channel and role IDs: in Discord turn on Settings → Advanced → Developer Mode, then right-click → Copy ID."
  info "Press Enter to keep a value in [brackets]; optional values can stay empty."
  echo
  ask DISCORD_TOKEN       "Bot token" token
  ask DISCORD_CLIENT_ID   "Application ID (the same as the Client ID)" id
  ask GUILD_ID            "Server ID" id
  ask TEAM_ROLE_ID        "Team role ID" id
  ask WELCOME_CHANNEL_ID  "Welcome channel ID (empty = no welcome messages)" opt
  ask WELCOME_ROLE_ID     "Role for new members (optional)" opt
  ask RULES_CHANNEL_ID    "Rules channel (optional, shown in the welcome)" opt
  ask SUPPORT_CHANNEL_ID  "Support channel (optional, shown in the welcome)" opt
  ask SUGGESTION_FORUM_ID "Suggestion forum channel ID" opt
  ask TAG_ACCEPTED_ID     "Forum tag for accepted suggestions (optional)" opt
  ask TAG_DECLINED_ID     "Forum tag for declined suggestions (optional)" opt
  ask SUPPORT_CATEGORY_ID "Category for ticket channels" opt
  ask SITE_URL            "Website address" url "${OYS_SITE_URL:-https://on-your.site}"
  PRESET_SECRET=${OYS_BOT_SECRET:-}
  if [ -z "$(current BOT_SECRET)" ] && [ "${#PRESET_SECRET}" -ge 32 ]; then
    # Vom Server-Installer: steht schon in config.php
    VAL_BOT_SECRET=$PRESET_SECRET
    info "Secret for the website connection: taken from config.php."
  elif [ -z "$(current BOT_SECRET)" ]; then
    case "$(choose "Create a new secret for the website connection? [Y/n]" y)" in
      [nN]*) ask BOT_SECRET "Secret (the same as bot_secret in config.php)" secret ;;
      *) VAL_BOT_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'); NEW_SECRET=$VAL_BOT_SECRET ;;
    esac
  else
    ask BOT_SECRET "Secret for the website connection" secret
  fi
  ask POLL_SECONDS "Check the website for changes every … seconds" seconds 10

  # Nur für root lesbar; erst komplett schreiben, dann ersetzen
  umask 077
  tmp=$(mktemp "$ENV_FILE.XXXXXX")
  {
    echo "# OnYourSite Discord bot – written by install.sh on $(date -u +%Y-%m-%d). Keep this file private."
    for key in DISCORD_TOKEN DISCORD_CLIENT_ID GUILD_ID TEAM_ROLE_ID WELCOME_CHANNEL_ID WELCOME_ROLE_ID RULES_CHANNEL_ID SUPPORT_CHANNEL_ID \
               SUGGESTION_FORUM_ID TAG_ACCEPTED_ID TAG_DECLINED_ID SUPPORT_CATEGORY_ID SITE_URL BOT_SECRET POLL_SECONDS; do
      var="VAL_$key"
      echo "$key=${!var:-}"
    done
  } > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  umask 022
  info "Saved to $ENV_FILE (readable only by root)."
  if [ -n "$NEW_SECRET" ]; then
    echo
    info "Add this line to config.php of the website (same secret on both sides):"
    echo
    echo "      'bot_secret' => '$NEW_SECRET',"
    echo
    read -rp "  Press Enter once it’s in config.php … " _ || true
  fi
fi

# ---------------------------------------------------------------
bold "3/4  Installing and checking the connection to the website"
if [ "$MODE" = service ]; then
  # Eigener Benutzer ohne Anmeldung; der Code liegt außerhalb des Webordners und gehört root
  if ! id -u "$NAME" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /nonexistent --shell "$(command -v nologin || echo /bin/false)" "$NAME"
  fi
  install -d -m 755 "$APP_DIR"
  rm -rf "$APP_DIR/src"
  cp "$SRC/package.json" "$SRC/package-lock.json" "$SRC/index.js" "$APP_DIR/"
  cp -r "$SRC/src" "$APP_DIR/src"
  (cd "$APP_DIR" && PATH="$NODE_BIN:$PATH" npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  chown -R root:root "$APP_DIR"
  chmod -R u=rwX,go=rX "$APP_DIR"
  CHECK=(env BOT_ENV_FILE="$ENV_FILE" "$NODE" "$APP_DIR/index.js" --check)
else
  "${COMPOSE[@]}" build --pull
  # -T und </dev/null: der Prüf-Container darf die Eingaben dieses Skripts nicht mitlesen
  CHECK=("${COMPOSE[@]}" run --rm --no-deps -T bot node index.js --check)
fi
if "${CHECK[@]}" </dev/null; then
  info "The website accepts the bot."
else
  info "The website didn’t accept the bot. Check that:"
  info "  - the website is updated and has 'bot_secret' in config.php,"
  info "  - it’s exactly the same secret as here,"
  info "  - the website address is right (and points to the website’s server)."
  if [ "$UPDATE" = 1 ]; then
    # Bei Updates nicht hängen bleiben: der Bot versucht es selbst weiter, bis die Webseite wieder antwortet
    info "Starting anyway – the bot keeps trying and logs when the website answers again."
  else
    case "$(choose "Start the bot anyway? [y/N]" n)" in
      [yY]*) ;;
      *) fail "Not started. Fix the settings and run install.sh again." ;;
    esac
  fi
fi

# ---------------------------------------------------------------
bold "4/4  Starting the bot"
if [ "$MODE" = service ]; then
  cat > "$UNIT" <<UNIT_FILE
# OnYourSite Discord bot – written by discord-bot/install.sh
[Unit]
Description=OnYourSite Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$NAME
Group=$NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
ExecStart=$NODE $APP_DIR/index.js
Restart=always
RestartSec=5
# The bot only needs the network: no writing, no extra rights
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT_FILE
  systemctl daemon-reload
  systemctl enable "$NAME" >/dev/null 2>&1
  systemctl restart "$NAME"
  sleep 6
  journalctl -u "$NAME" -n 15 --no-pager || true
  systemctl is-active --quiet "$NAME" || info "The service isn’t running – see the log above."

  bold "Done."
  info "The bot runs as the system service $NAME and starts by itself after a crash or a reboot."
  info "Code: $APP_DIR · settings: $ENV_FILE (readable only by root)"
  info "Logs:            journalctl -u $NAME -f"
  info "Restart:         systemctl restart $NAME"
  info "Stop:            systemctl stop $NAME"
  info "Change settings: sudo bash $SRC/install.sh"
  info "After an update: sudo bash $SRC/install.sh --update   (server/install.sh --update does this for you)"
else
  "${COMPOSE[@]}" up -d --remove-orphans
  sleep 6
  "${COMPOSE[@]}" logs --tail 15 bot || true

  bold "Done."
  info "The bot restarts by itself after a crash or a server reboot."
  info "Logs:            ${COMPOSE[*]} logs -f bot      (in $SRC)"
  info "Restart:         ${COMPOSE[*]} restart bot"
  info "Stop:            ${COMPOSE[*]} down"
  info "Change settings: sudo bash install.sh"
  info "After an update: git pull && sudo bash install.sh --update"
fi
info "In Discord, run /support-panel in your support channel and /bot-status to see the connection."
