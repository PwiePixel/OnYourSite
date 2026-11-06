#!/usr/bin/env bash
# OnYourSite – die Beta-Webseite: eine zweite Installation neben der Hauptseite, mit den Pre-Releases (Branch beta).
# Aufgerufen von server/install.sh (nie allein – der Installer hält die Sperre und kennt die Einstellungen):
#
#   sudo bash server/install.sh --beta       einrichten oder auf den neuesten Stand des Branches beta bringen
#   sudo bash server/install.sh --beta-off   wieder entfernen (die Hauptseite bleibt, wie sie ist)
#   sudo bash server/install.sh --update     aktualisiert die Beta-Webseite mit, wenn sie eingerichtet ist
#
# Was entsteht: der Code in /var/www/onyoursite-beta (Branch beta, sonst OYS_BETA_BRANCH), gebaut wie die Hauptseite
# daneben in onyoursite-beta.next und erst nach Bau und Datenbank umgeschaltet (antwortet sie nicht, kommt die vorige zurück),
# der Dienst onyoursite-beta (Node.js als www-data, nur 127.0.0.1, Port der Hauptseite + 1), eigene config.json (eine
# Kopie der Einstellungen der Hauptseite mit beta_build: true, base_domain beta.<domain> und dem eigenen Port) und in
# der config.json der Hauptseite beta_site { port, dir } – damit reicht die Hauptseite angemeldete Tester auf
# beta.<domain> an die Beta-Webseite weiter (app/src/beta/site.ts). Apache, Zertifikat und Tunnel ändern sich nicht:
# beta.<domain> geht schon heute an die Hauptseite.
#
# Dieselbe Datenbank, dieselben Uploads: die Beta-Webseite bringt die Datenbank auf ihren Stand (neue Schema-Schritte
# laufen sofort – vorher eine Sicherung); die Hauptseite kommt mit einer neueren Datenbank zurecht und überspringt die
# Schritte später. Schema-Schritte im Branch beta müssen darum dieselbe Nummer behalten, mit der sie nach main kommen.
{
set -euo pipefail
umask 022

[ "$(id -u)" = 0 ] || { echo "Run this through the installer: sudo bash server/install.sh --beta" >&2; exit 1; }
[ -n "${OYS_INSTALL_LOCKED:-}" ] || { echo "Run this through the installer: sudo bash server/install.sh --beta" >&2; exit 1; }

CONF=/etc/onyoursite/server.conf
UNITS=/etc/systemd/system
BETA_UNIT=$UNITS/onyoursite-beta.service
DATA_DIR=/var/lib/onyoursite
WEB=www-data
BETA=${OYS_BETA_DIR:-/var/www/onyoursite-beta}
BETA_BRANCH=${OYS_BETA_BRANCH:-beta}
DEPLOY_KEY=/root/.ssh/onyoursite_deploy
GITHUB_HOSTS=/root/.ssh/github_known_hosts

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
conf_get() { if [ -f "$CONF" ]; then sed -n "s/^$1=//p" "$CONF" | tail -n 1; fi; }

CODE=$(conf_get CODE)
NODE=$(conf_get NODE)
DOMAIN=$(conf_get DOMAIN)
[ -n "$CODE" ] && [ -f "$CODE/config.json" ] || fail "OnYourSite isn’t set up on this server yet – run the installer first."
[ -n "$NODE" ] && [ -x "$NODE" ] || fail "Node.js of the website is missing – run: sudo bash $CODE/server/install.sh --update"
NODE_BIN=$(dirname "$NODE")
CONFIG_MJS=$CODE/app/scripts/config.mjs
MAIN_CFG=$CODE/config.json

cfg_get() { "$NODE" "$CONFIG_MJS" get "$1" --file "${2:-$MAIN_CFG}" 2>/dev/null || true; }
main_port() {
  local p
  p=$(cfg_get node_port)
  if [[ $p =~ ^[0-9]+$ ]] && [ "$p" -gt 0 ] && [ "$p" -lt 65535 ]; then printf '%s' "$p"; else printf '3000'; fi
}

# Git wie beim Code der Hauptseite: dieselbe Quelle (bei einem privaten Repository mit dessen Deploy-Schlüssel)
git_beta() {
  local ssh_cmd=""
  if [ -f "$DEPLOY_KEY" ]; then ssh_cmd="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$GITHUB_HOSTS -o StrictHostKeyChecking=yes"; fi
  GIT_SSH_COMMAND=${ssh_cmd:-ssh} git -c safe.directory="$BETA" -c safe.directory="$CODE" "$@"
}

# Den Webserver-Dienst der Hauptseite neu starten und warten, bis er wieder antwortet (liest config.json nur beim Start)
restart_main() {
  local port code end=$((SECONDS + 60))
  port=$(main_port)
  systemctl restart onyoursite-web
  while [ "$SECONDS" -lt "$end" ]; do
    code=$(curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" "http://127.0.0.1:$port/" 2>/dev/null || true)
    if [ "$code" = 200 ]; then return 0; fi
    sleep 0.3
  done
  warn "The website didn’t answer after the restart – see: journalctl -u onyoursite-web"
}

# beta_site in der config.json der Hauptseite: JSON-Wert oder null; 0 = geändert
set_beta_site() {
  local now
  now=$("$NODE" -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify(j.beta_site ?? null))' "$MAIN_CFG")
  [ "$now" != "$1" ] || return 1
  OYS_VALUE=$1 "$NODE" "$CONFIG_MJS" set beta_site --json --file "$MAIN_CFG" >/dev/null || fail "config.json couldn’t be changed – see above."
  return 0
}

remove_beta() {
  bold "Removing the beta website"
  systemctl disable --now onyoursite-beta >/dev/null 2>&1 || true
  rm -f "$BETA_UNIT"
  systemctl daemon-reload
  if set_beta_site null; then restart_main; fi
  rm -rf "$BETA" "$BETA.next" "$BETA.previous"
  info "The beta website is gone. The beta panel at beta.$DOMAIN/_beta/ stays – testers can still send reports."
}

# Antwortet die Beta-Webseite auf PORT? Höchstens 60 Sekunden; 0 = ja
wait_beta() {
  local code end=$((SECONDS + 60))
  while [ "$SECONDS" -lt "$end" ]; do
    code=$(curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: beta.$DOMAIN" "http://127.0.0.1:$1/" 2>/dev/null || true)
    if [ "$code" = 200 ]; then return 0; fi
    sleep 0.3
  done
  return 1
}

# Lauscht schon etwas (außer der Beta-Webseite) auf dem Port? Dann nie dorthin weiterreichen
port_taken() {
  if systemctl is-active --quiet onyoursite-beta; then return 1; fi
  ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
}

write_unit() {
  cat > "$BETA_UNIT" <<EOF2
# OnYourSite beta website – written by server/beta.sh (install.sh --beta)
[Unit]
Description=OnYourSite beta website (Node.js, branch $BETA_BRANCH)
After=network-online.target mariadb.service onyoursite-web.service
Wants=network-online.target

[Service]
Type=simple
User=$WEB
Group=$WEB
WorkingDirectory=$BETA/app
Environment=NODE_ENV=production TMPDIR=$DATA_DIR/tmp-beta
ExecStart=$NODE $BETA/app/dist/server.js
Restart=always
RestartSec=2
TimeoutStopSec=30
UMask=0022
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ReadWritePaths=$1 $DATA_DIR/tmp-beta $BETA/email
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
MemoryMax=768M
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF2
}

setup_beta() {
  local url port log cfg_new uploads next="$BETA.next" prev="$BETA.previous"
  bold "Beta website (branch $BETA_BRANCH)"
  url=$(git -c safe.directory="$CODE" -C "$CODE" remote get-url origin 2>/dev/null || true)
  [ -n "$url" ] || fail "$CODE has no git source – the beta website needs the code from GitHub."
  if ! git_beta ls-remote --exit-code --heads "$url" "$BETA_BRANCH" >/dev/null 2>&1; then
    fail "There is no branch $BETA_BRANCH on GitHub yet – create it from main (GitHub → Branches → New branch), then run this again."
  fi
  # Port: wie bisher (config.json der Beta-Webseite), sonst BETA_PORT aus server.conf, sonst der der Hauptseite + 1
  port=$(cfg_get node_port "$BETA/config.json")
  if ! [[ $port =~ ^[0-9]+$ ]]; then port=$(conf_get BETA_PORT); fi
  if ! [[ $port =~ ^[0-9]+$ ]]; then port=$(( $(main_port) + 1 )); fi
  if port_taken "$port"; then
    fail "Port $port is already used by another program – set BETA_PORT=<free port> in $CONF and run this again."
  fi

  # Die neue Version entsteht neben der laufenden (wie beim Update der Hauptseite): die Beta-Webseite läuft weiter,
  # bis sie gebaut und geprüft ist
  rm -rf "$next"
  git_beta clone -q --depth 1 --branch "$BETA_BRANCH" "$url" "$next" || fail "git clone didn’t work – see above. The beta website keeps running as before."
  info "Version: $(tr -d '[:space:]' < "$next/VERSION" 2>/dev/null || echo unknown) ($(git_beta -C "$next" rev-parse --short HEAD))"
  info "Building the beta website (npm ci and TypeScript) – this takes a minute or two …"
  log=$(mktemp)
  if ! (cd "$next/app" && export PATH="$NODE_BIN:$PATH" \
      && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error \
      && npm run build --silent \
      && (cd src && find . -type f ! -name '*.ts' ! -name '*.js' -exec cp --parents {} ../dist/ \;) \
      && npm prune --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) >"$log" 2>&1; then
    tail -n 30 "$log" | sed 's/^/    /'
    rm -f "$log"
    rm -rf "$next"
    fail "The beta website couldn’t be built – see above. It keeps running as before; the main website isn’t affected."
  fi
  rm -f "$log"
  chmod -R go+rX "$next"
  runuser -u "$WEB" -- "$NODE" "$next/app/dist/cli.js" check --native | sed 's/^/  /' || { rm -rf "$next"; fail "The beta website doesn’t run on this server – see above."; }

  # Dieselben Uploads wie die Hauptseite (als fester Pfad – ein relativer zeigte sonst in den Ordner der Beta)
  uploads=$(cfg_get uploads_dir)
  case $uploads in "") uploads=$CODE/static/uploads ;; /*) ;; *) uploads=$CODE/$uploads ;; esac
  uploads=${uploads%/}
  # Einstellungen: die der Hauptseite, mit eigenem Port, eigener Adresse und dem Kennzeichen beta_build
  cfg_new=$(mktemp)
  "$NODE" -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    delete j.beta_site;
    j.beta_build = true;
    j.node_port = Number(process.argv[2]);
    j.base_domain = "beta." + String(j.base_domain || process.argv[3]);
    j.uploads_dir = process.argv[5];
    fs.writeFileSync(process.argv[4], JSON.stringify(j, null, 2) + "\n");
  ' "$MAIN_CFG" "$port" "$DOMAIN" "$cfg_new" "$uploads"
  install -m 640 -o root -g "$WEB" "$cfg_new" "$next/config.json"
  rm -f "$cfg_new"
  # Mail-Einstellungen wie die Hauptseite (die Beta-Webseite schickt dieselben Mails)
  install -d -m 750 -o "$WEB" -g "$WEB" "$next/email"
  if [ -f "$CODE/email/smtp.json" ] && [ ! -L "$CODE/email/smtp.json" ]; then install -m 640 -o "$WEB" -g "$WEB" "$CODE/email/smtp.json" "$next/email/smtp.json"; fi

  # Neue Schema-Schritte der Beta treffen die echte Datenbank: vorher eine Sicherung
  if ! runuser -u "$WEB" -- env OYS_CONFIG="$next/config.json" NODE_ENV=production "$NODE" "$next/app/dist/cli.js" migrate --pending >/dev/null 2>&1; then
    info "The beta version brings changes to the database – making a backup first …"
    bash "$CODE/server/backup.sh" before-beta || { rm -rf "$next"; fail "The backup didn’t work – the database wasn’t changed."; }
  fi
  runuser -u "$WEB" -- env OYS_CONFIG="$next/config.json" NODE_ENV=production "$NODE" "$next/app/dist/cli.js" migrate | sed 's/^/  /' \
    || { rm -rf "$next"; fail "The database couldn’t be brought to the beta version – see above. The main website keeps running."; }

  # Umschalten: die bisherige Version wartet als .previous, bis die neue antwortet
  install -d -m 700 -o "$WEB" -g "$WEB" "$DATA_DIR/tmp-beta"
  systemctl stop onyoursite-beta >/dev/null 2>&1 || true
  rm -rf "$prev"
  if [ -d "$BETA" ]; then mv "$BETA" "$prev"; fi
  mv "$next" "$BETA"
  write_unit "$uploads"
  systemctl daemon-reload
  systemctl enable onyoursite-beta >/dev/null 2>&1
  systemctl restart onyoursite-beta
  if ! wait_beta "$port"; then
    journalctl -u onyoursite-beta -n 20 --no-pager 2>/dev/null | sed 's/^/    /' || true
    if [ -d "$prev" ]; then
      warn "The new beta version doesn’t answer – going back to the previous one."
      systemctl stop onyoursite-beta >/dev/null 2>&1 || true
      rm -rf "$BETA"
      mv "$prev" "$BETA"
      systemctl restart onyoursite-beta
      wait_beta "$port" || true
    fi
    fail "The beta website didn’t answer on port $port – see the log above (journalctl -u onyoursite-beta). The main website isn’t affected."
  fi
  rm -rf "$prev"
  info "The beta website answers (port $port)."
  # Die Hauptseite reicht Tester erst jetzt weiter (nur beim ersten Mal oder nach einer Änderung neu gestartet)
  if set_beta_site "{\"port\":$port,\"dir\":\"$BETA\"}"; then restart_main; fi
  info "Testers open it at https://beta.$DOMAIN/ after logging in (panel: https://beta.$DOMAIN/_beta/)."
  info "Errors:   journalctl -u onyoursite-beta -f"
}

case ${1:-setup} in
  setup) setup_beta ;;
  update) if [ -f "$BETA_UNIT" ]; then setup_beta; fi ;;
  remove) remove_beta ;;
  *) fail "Unknown option: $1" ;;
esac
exit 0
}
