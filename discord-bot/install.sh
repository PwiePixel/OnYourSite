#!/usr/bin/env bash
# OnYourSite Discord-Bot – Installation auf einem Linux-Server mit Docker.
#
#   Erstinstallation / Einstellungen ändern:  sudo ./install.sh
#   Nach einem Update (git pull):             sudo ./install.sh --update
#
# Fragt die Einstellungen ab (beim erneuten Aufruf bleiben die bisherigen Werte mit Enter erhalten),
# schreibt sie in .env (nur für root lesbar), baut das Image, prüft die Verbindung zur Webseite und
# startet den Bot als Container, der nach Abstürzen und Neustarts des Servers von selbst wieder läuft.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# Ja/Nein-Frage; endet die Eingabe (z. B. kein Terminal), gilt die Vorgabe
yes_no() {
  local reply
  read -rp "  $1 " reply || reply=""
  printf '%s' "${reply:-$2}"
}
info() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "Please run this as root."
  exec sudo bash "$0" "$@"
fi

UPDATE=0
case "${1:-}" in
  --update) UPDATE=1 ;;
  "") ;;
  *) fail "Unknown option: $1 (use --update or nothing)" ;;
esac

ENV_FILE=.env
NEW_SECRET=""

# ---------------------------------------------------------------
bold "1/4  Docker"
if ! command -v docker >/dev/null 2>&1; then
  [ "$UPDATE" = 1 ] && fail "Docker is not installed. Run ./install.sh without --update."
  case "$(yes_no "Docker is not installed. Install it now with the official script from get.docker.com? [Y/n]" y)" in
    [nN]*) fail "The bot runs in Docker. Install Docker and run this again." ;;
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

# ---------------------------------------------------------------
bold "2/4  Settings"
# Bisheriger Wert aus .env (ohne die Datei auszuführen)
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
      read -rsp "  $label$hint: " value || fail "The input ended – please run ./install.sh in a terminal."
      echo
    else
      read -rp "  $label${def:+ [$def]}: " value || fail "The input ended – please run ./install.sh in a terminal."
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
  [ -f "$ENV_FILE" ] || fail "There are no settings yet. Run ./install.sh without --update first."
  info "Keeping the settings in $(pwd)/$ENV_FILE"
else
  info "IDs: in Discord turn on Settings → Advanced → Developer Mode, then right-click → Copy ID."
  info "Press Enter to keep a value in [brackets]; optional values can stay empty."
  echo
  ask DISCORD_TOKEN       "Bot token" token
  ask DISCORD_CLIENT_ID   "Application ID (Developer Portal → General Information)" id
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
  ask SITE_URL            "Website address" url "https://on-your.site"
  if [ -z "$(current BOT_SECRET)" ]; then
    case "$(yes_no "Create a new secret for the website connection? [Y/n]" y)" in
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
  info "Saved to $(pwd)/$ENV_FILE (readable only by root)."
  if [ -n "$NEW_SECRET" ]; then
    echo
    info "Add this line to config.php on the website (same secret on both sides):"
    echo
    echo "      'bot_secret' => '$NEW_SECRET',"
    echo
    read -rp "  Press Enter once it’s in config.php … " _ || true
  fi
fi

# ---------------------------------------------------------------
bold "3/4  Building and checking the connection to the website"
"${COMPOSE[@]}" build --pull
# -T und </dev/null: der Prüf-Container darf die Eingaben dieses Skripts nicht mitlesen
if "${COMPOSE[@]}" run --rm --no-deps -T bot node index.js --check </dev/null; then
  info "The website accepts the bot."
else
  info "The website didn’t accept the bot. Check that:"
  info "  - the website is updated and has 'bot_secret' in config.php,"
  info "  - it’s exactly the same secret as here,"
  info "  - the website address is right."
  if [ "$UPDATE" = 1 ]; then
    # Bei Updates nicht hängen bleiben: der Bot versucht es selbst weiter, bis die Webseite wieder antwortet
    info "Starting anyway – the bot keeps trying and logs when the website answers again."
  else
    case "$(yes_no "Start the bot anyway? [y/N]" n)" in
      [yY]*) ;;
      *) fail "Not started. Fix the settings and run ./install.sh again." ;;
    esac
  fi
fi

# ---------------------------------------------------------------
bold "4/4  Starting the bot"
"${COMPOSE[@]}" up -d --remove-orphans
sleep 6
"${COMPOSE[@]}" logs --tail 15 bot || true

bold "Done."
info "The bot restarts by itself after a crash or a server reboot."
info "Logs:            ${COMPOSE[*]} logs -f bot      (in $(pwd))"
info "Restart:         ${COMPOSE[*]} restart bot"
info "Stop:            ${COMPOSE[*]} down"
info "Change settings: sudo ./install.sh"
info "After an update: git pull && sudo ./install.sh --update"
info "In Discord, run /support-panel in your support channel and /bot-status to see the connection."
