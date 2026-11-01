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
# Pakete immer ohne Rückfragen installieren – auch die Programme, die apt nebenbei startet
# (debconf, apt-listchanges bei Debian, needrestart bei Ubuntu), sonst warten sie unsichtbar auf eine Taste
export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none NEEDRESTART_MODE=a
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
  exec sudo bash "$SRC/$(basename "$0")" "$@"
fi

# In Meldungen: „sudo“ nur, wenn über sudo gestartet
SUDO_HINT=""
if [ -n "${SUDO_USER:-}" ]; then SUDO_HINT="sudo "; fi

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
    fail "The bot isn’t installed yet. Run: ${SUDO_HINT}bash $SRC/install.sh"
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
    info "Installing Node.js 22 – this takes a minute or two …"
    # Die Ausgabe kommt in eine Datei und wird nur bei einem Fehler gezeigt
    log=$(mktemp)
    if ! { curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; } >"$log" 2>&1 \
      || ! apt-get -o DPkg::Lock::Timeout=600 install -y -qq nodejs >>"$log" 2>&1; then
      tail -n 25 "$log" | grep -v "stable CLI interface" | sed 's/^/    /'
      rm -f "$log"
      fail "Node.js couldn’t be installed – see above."
    fi
    rm -f "$log"
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
bold "2/4  Installing the bot"
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
  info "Installed in $APP_DIR"
else
  "${COMPOSE[@]}" build --pull
fi

# Werkzeuge des Bots (Discord prüfen, Server einrichten). Token und IDs gehen über die Umgebung, nie über die Befehlszeile.
bot_tool() {
  if [ "$MODE" = service ]; then
    DISCORD_TOKEN=$TOKEN "$NODE" "$APP_DIR/index.js" "$@" </dev/null
  else
    DISCORD_TOKEN=$TOKEN "${COMPOSE[@]}" run --rm --no-deps -T -e DISCORD_TOKEN -e DISCORD_API_BASE -e TEAM_ROLE_ID \
      -e WELCOME_CHANNEL_ID -e RULES_CHANNEL_ID -e SUPPORT_CHANNEL_ID -e SUGGESTION_FORUM_ID -e SUPPORT_CATEGORY_ID \
      bot node index.js "$@" </dev/null
  fi
}

# ---------------------------------------------------------------
bold "3/4  Settings"
NEW_SECRET=""
# Bisheriger Wert aus der Einstellungsdatei (ohne sie auszuführen)
current() {
  if [ -f "$ENV_FILE" ]; then sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; fi
}

# ask KEY "Frage" Art [Vorgabe] – Art: id (Discord-ID), token, secret, url
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
      id)     [[ $value =~ ^[0-9]{15,22}$ ]] && break; info "  Please paste the Application ID (digits only)." ;;
      token)  [[ $value =~ ^[A-Za-z0-9._-]{50,}$ ]] && break; info "  That doesn’t look like a bot token (Developer Portal → Bot → Reset Token)." ;;
      secret) [[ ${#value} -ge 32 && $value =~ ^[A-Za-z0-9._~+/=-]+$ ]] && break; info "  At least 32 characters, letters and digits." ;;
      url)    [[ $value =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] && break; info "  The address of the website with https://, e.g. https://on-your.site" ;;
    esac
  done
  printf -v "VAL_$key" '%s' "$value"
}

if [ "$UPDATE" = 1 ]; then
  [ -f "$ENV_FILE" ] || fail "There are no settings yet. Run: ${SUDO_HINT}bash $SRC/install.sh"
  info "Keeping the settings in $ENV_FILE"
else
  info "From the Discord Developer Portal (discord.com/developers/applications) you only need two things:"
  info "  1. New Application → tab Bot → Reset Token. On the same tab turn on Server Members Intent and"
  info "     Message Content Intent, and turn off Public Bot."
  info "  2. Tab General Information → Application ID."
  info "The installer sets up everything else on your Discord server by itself – the Staff role, the channels and"
  info "their IDs. The Client Secret isn’t needed."
  echo
  errf=$(mktemp)
  # 1. Token – Discord muss es annehmen
  while true; do
    ask DISCORD_TOKEN "Bot token" token
    TOKEN=$VAL_DISCORD_TOKEN
    if app=$(bot_tool --discord-app 2>"$errf"); then break; fi
    info "  Discord doesn’t accept this token: $(tr '\n' ' ' < "$errf")"
    info "  Copy it again (Bot → Reset Token) and paste it."
    sed -i '/^DISCORD_TOKEN=/d' "$ENV_FILE" 2>/dev/null || true
  done
  app_id=$(sed -n 's/^APP_ID=//p' <<< "$app")
  invite=$(sed -n 's/^INVITE=//p' <<< "$app")
  info "Discord knows this bot: $(sed -n 's/^APP_NAME=//p' <<< "$app")"

  # 2. Application ID – muss zum Token gehören
  ask DISCORD_CLIENT_ID "Application ID" id "$app_id"
  if [ "$VAL_DISCORD_CLIENT_ID" != "$app_id" ]; then
    info "  This token belongs to the application $app_id – using that one."
    VAL_DISCORD_CLIENT_ID=$app_id
  fi

  # 3. Discord-Server: der Bot muss eingeladen sein
  while true; do
    guilds=$(bot_tool --discord-guilds 2>"$errf") || fail "Discord can’t be reached: $(tr '\n' ' ' < "$errf")"
    if [ -n "$guilds" ]; then break; fi
    info "The bot isn’t on your Discord server yet. Open this link, choose your server and authorize:"
    echo
    echo "    $invite"
    echo
    read -rp "  Press Enter once the bot is on your server … " _ || fail "The input ended – please run install.sh in a terminal."
  done
  mapfile -t guild_lines <<< "$guilds"
  guild_id=""
  if [ "${#guild_lines[@]}" -eq 1 ]; then
    guild_id=$(sed -n 's/^GUILD_\([0-9]*\)=.*/\1/p' <<< "${guild_lines[0]}")
    info "Discord server: ${guild_lines[0]#*=}"
  else
    info "The bot is on several servers – which one is yours?"
    def=1
    for i in "${!guild_lines[@]}"; do
      info "  $((i + 1))) ${guild_lines[$i]#*=}"
      if [ "$(sed -n 's/^GUILD_\([0-9]*\)=.*/\1/p' <<< "${guild_lines[$i]}")" = "$(current GUILD_ID)" ]; then def=$((i + 1)); fi
    done
    while true; do
      pick=$(choose "Choose 1–${#guild_lines[@]} [$def]:" "$def")
      if [[ $pick =~ ^[0-9]+$ ]] && [ "$pick" -ge 1 ] && [ "$pick" -le "${#guild_lines[@]}" ]; then break; fi
    done
    guild_id=$(sed -n 's/^GUILD_\([0-9]*\)=.*/\1/p' <<< "${guild_lines[$((pick - 1))]}")
  fi

  # 4. Rolle und Kanäle anlegen (oder die vorhandenen wiederfinden) und alle IDs übernehmen
  info "Setting up the Discord server …"
  setup=$(TEAM_ROLE_ID=$(current TEAM_ROLE_ID) WELCOME_CHANNEL_ID=$(current WELCOME_CHANNEL_ID) \
    RULES_CHANNEL_ID=$(current RULES_CHANNEL_ID) SUPPORT_CHANNEL_ID=$(current SUPPORT_CHANNEL_ID) \
    SUGGESTION_FORUM_ID=$(current SUGGESTION_FORUM_ID) SUPPORT_CATEGORY_ID=$(current SUPPORT_CATEGORY_ID) \
    bot_tool --discord-setup "$guild_id" 2>"$errf") \
    || fail "The Discord server couldn’t be set up: $(tr '\n' ' ' < "$errf") – is the bot invited with the link above?"
  rm -f "$errf"
  while IFS='=' read -r key value; do
    case $key in
      DONE) info "  $value" ;;
      WARN) info "  Note: $value" ;;
      GUILD_ID|TEAM_ROLE_ID|WELCOME_CHANNEL_ID|RULES_CHANNEL_ID|SUPPORT_CHANNEL_ID|SUGGESTION_FORUM_ID|TAG_ACCEPTED_ID|TAG_DECLINED_ID|SUPPORT_CATEGORY_ID)
        printf -v "VAL_$key" '%s' "$value" ;;
    esac
  done <<< "$setup"
  # Optional: Rolle für neue Mitglieder – bleibt, wie sie in der Datei steht (wird unten über ${!var} geschrieben)
  # shellcheck disable=SC2034
  VAL_WELCOME_ROLE_ID=$(current WELCOME_ROLE_ID)

  # 5. Verbindung zur Webseite
  ask SITE_URL "Website address" url "${OYS_SITE_URL:-https://on-your.site}"
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
  VAL_POLL_SECONDS=$(current POLL_SECONDS)
  VAL_POLL_SECONDS=${VAL_POLL_SECONDS:-10}

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
bold "4/4  Checking and starting"
if [ "$MODE" = service ]; then
  CHECK=(env BOT_ENV_FILE="$ENV_FILE" "$NODE" "$APP_DIR/index.js" --check)
else
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
  info "Change settings: ${SUDO_HINT}bash $SRC/install.sh"
  info "After an update: ${SUDO_HINT}bash $SRC/install.sh --update   (server/install.sh --update does this for you)"
else
  "${COMPOSE[@]}" up -d --remove-orphans
  sleep 6
  "${COMPOSE[@]}" logs --tail 15 bot || true

  bold "Done."
  info "The bot restarts by itself after a crash or a server reboot."
  info "Logs:            ${COMPOSE[*]} logs -f bot      (in $SRC)"
  info "Restart:         ${COMPOSE[*]} restart bot"
  info "Stop:            ${COMPOSE[*]} down"
  info "Change settings: ${SUDO_HINT}bash install.sh"
  info "After an update: git pull && ${SUDO_HINT}bash install.sh --update"
fi
info "The bot posts the support panel in your support channel by itself. In Discord, /bot-status shows the connection."
