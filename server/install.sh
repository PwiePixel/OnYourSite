#!/usr/bin/env bash
# OnYourSite auf einem eigenen Server (ohne Plesk) – richtet alles auf einem frischen Ubuntu- oder Debian-Server ein.
#
#   curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
#                                          Einrichten mit einem Befehl: holt sich alles selbst – Pakete, den Code von
#                                          GitHub, Datenbank, Zertifikat, Firewall. Geht auch als Datei: sudo bash install.sh
#                                          Erneut aufgerufen: Einstellungen ändern (Enter behält die Werte).
#                                          --branch NAME holt einen anderen Branch (z. B. zum Testen vor dem Merge).
#   sudo bash server/install.sh --update   Neue Version holen – erst eine Sicherung, dann wird die neue Version neben der
#                                          laufenden gebaut, geprüft und erst danach umgeschaltet. Läuft hier noch die
#                                          PHP-Version (2.x), zieht die Seite dabei auf Node.js um.
#   sudo bash server/install.sh --https    Nur das Zertifikat einrichten (nach „Later“ oder bei einem neuen DNS-Anbieter)
#   sudo bash server/install.sh --tunnel   Nur den Cloudflare-Tunnel einrichten oder reparieren
#   sudo bash server/install.sh --reset    Alles neu: Datenbank, Uploads und Schlüssel löschen (vorher ein Backup)
#
# Die Webseite läuft mit Node.js 22 als Dienst onyoursite-web (Benutzer www-data, nur auf 127.0.0.1); Apache nimmt die
# Anfragen mit HTTPS an und reicht alles an Node weiter. Dazu MariaDB, ein Let’s-Encrypt-Zertifikat für die Domain und
# alle Subdomains (über die DNS-API des Domain-Anbieters), Wochenbericht, nächtliche Sicherung und Zertifikats-
# Erneuerung als systemd-Timer, Firewall, fail2ban und weitere Absicherung, das erste Admin-Konto – und auf Wunsch der
# Umzug der Daten vom alten Server. PHP braucht der Server nicht. Anleitung: server/README.md

# Alles steht in einem Block: bash liest so das ganze Skript, bevor es startet. Das braucht „curl … | sudo bash“
# (danach kommen die Antworten von der Tastatur), und ein Update ändert so nichts am laufenden Skript.
{
set -euo pipefail
umask 022
# Pakete immer ohne Rückfragen installieren – auch die Programme, die apt nebenbei startet
# (debconf, apt-listchanges bei Debian, needrestart bei Ubuntu), sonst warten sie unsichtbar auf eine Taste
export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none NEEDRESTART_MODE=a

# Bei „bash <(curl …)“ oder „bash /dev/stdin“ gibt es keinen Ordner – dann leer, get_code holt den Code.
# Beim Update startet die neue Version des Installers aus einer Zwischendatei; den Code-Ordner nennt dann OYS_CODE.
CODE=${OYS_CODE:-$( { cd "$(dirname "$(readlink -f "$0" 2>/dev/null)")/.." 2>/dev/null && pwd; } || true)}
TARGET=/var/www/onyoursite
REPO=${OYS_REPO:-PwiePixel/OnYourSite}
BRANCH=${OYS_BRANCH:-main}
DEPLOY_KEY=/root/.ssh/onyoursite_deploy
GITHUB_HOSTS=/root/.ssh/github_known_hosts
CONF_DIR=/etc/onyoursite
CONF=$CONF_DIR/server.conf
DATA_DIR=/var/lib/onyoursite
UPLOADS=$DATA_DIR/uploads
SSL_DIR=/etc/ssl/onyoursite
BACKUPS=/var/backups/onyoursite
SITE_CONF=/etc/apache2/sites-available/onyoursite.conf
UNITS=/etc/systemd/system
ACME_HOME=/root/.acme.sh
ACME=$ACME_HOME/acme.sh
DB_NAME=onyoursite
DB_USER=onyoursite
WEB=www-data
CF_API=${OYS_CF_API:-https://api.cloudflare.com/client/v4}
CF_ENV=$CONF_DIR/cloudflare.env
TUNNEL_ENV=$CONF_DIR/tunnel.env
TUNNEL_UNIT=/etc/systemd/system/onyoursite-tunnel.service
WEB_UNIT=$UNITS/onyoursite-web.service
# Die Apache-Datei vor einem Update – schlägt die Prüfung nach dem Umschalten fehl, kommt sie zurück
PREVIOUS_SITE=$CONF_DIR/onyoursite.conf.previous
# So lange (Sekunden) darf die Webseite nach einem Start brauchen, bis sie antwortet
WEB_WAIT=60
NODE=""
NODE_BIN=""

# DNS-Anbieter mit API (Name|acme.sh-Modul); die Zugangsdaten stehen in provider_vars
PROVIDERS="Cloudflare|dns_cf
Hetzner|dns_hetznercloud
IONOS|dns_ionos
Netcup|dns_netcup
INWX|dns_inwx
all-inkl.com|dns_kas
Porkbun|dns_porkbun"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# Frage mit Vorgabe; endet die Eingabe (kein Terminal), gilt die Vorgabe
choose() {
  local reply
  read -rp "  $1 " reply || reply=""
  printf '%s' "${reply:-$2}"
}

# prompt VARIABLE "Frage" [hidden] – endet die Eingabe, bricht das Skript ab
prompt() {
  local __in
  if [ "${3:-}" = hidden ]; then
    read -rsp "  $2 " __in || fail "The input ended – please run the installer in a terminal."
    echo
  else
    read -rp "  $2 " __in || fail "The input ended – please run the installer in a terminal."
  fi
  printf -v "$1" '%s' "$__in"
}

conf_get() {
  if [ -f "$CONF" ]; then sed -n "s/^$1=//p" "$CONF" | tail -n 1; fi
}

# Paketverwaltung: auf einem frisch gestarteten Server laufen oft noch cloud-init oder automatische Updates –
# dann warten statt sofort mit „Could not get lock“ abzubrechen
apt_update() {
  local i key=/usr/share/keyrings/cloudflare-main.gpg
  if command -v cloud-init >/dev/null 2>&1; then timeout 900 cloud-init status --wait >/dev/null 2>&1 || true; fi
  # Cloudflare tauscht den Schlüssel seiner Paketquelle ab und zu aus – mit dem alten bräche jedes Update hier ab
  if [ -f /etc/apt/sources.list.d/cloudflared.list ]; then
    if curl -fsSL --max-time 30 https://pkg.cloudflare.com/cloudflare-main.gpg -o "$key.new" 2>/dev/null && [ -s "$key.new" ]; then
      mv -f "$key.new" "$key"
    else
      rm -f "$key.new"
    fi
  fi
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if apt-get -o DPkg::Lock::Timeout=600 update -qq; then return 0; fi
    info "The package lists are busy (an automatic update is running?) – trying again in 10 seconds …"
    sleep 10
  done
  fail "apt-get update didn’t work – see above."
}
apt_install() {
  apt-get -o DPkg::Lock::Timeout=600 install -y -qq "$@" >/dev/null
}

save_conf() {
  install -d -m 700 "$CONF_DIR"
  local tmp
  tmp=$(mktemp "$CONF.XXXXXX")
  {
    echo "# OnYourSite server settings – written by server/install.sh"
    echo "DOMAIN=$DOMAIN"
    echo "CODE=$CODE"
    echo "NODE=$NODE"
    echo "SSH_KEYONLY=$SSH_KEYONLY"
    echo "TUNNEL=$TUNNEL"
    echo "TUNNEL_ID=$TUNNEL_ID"
    echo "BACKUP_DAYS=$BACKUP_DAYS"
  } > "$tmp"
  mv "$tmp" "$CONF"
}

# Einstellungen der Seite: config.json – auf einem Server mit der PHP-Version (vor dem Umzug) noch config.php
cfg_file() {
  if [ -f "$CODE/config.json" ] || [ ! -f "$CODE/config.php" ]; then
    printf '%s' "$CODE/config.json"
  else
    printf '%s' "$CODE/config.php"
  fi
}

# Wert aus den Einstellungen (z. B. db.pass) – leer, wenn es ihn nicht gibt. Eine config.php wird dabei gelesen, nicht
# ausgeführt (app/scripts/config.mjs): PHP braucht es dafür nicht. cfg_get SCHLÜSSEL [DATEI]
cfg_get() {
  local file=${2:-$(cfg_file)}
  if [ ! -f "$file" ] || [ -z "$NODE" ] || [ ! -f "$CONFIG_MJS" ]; then return 0; fi
  "$NODE" "$CONFIG_MJS" get "$1" --file "$file" || true
}

ip4() {
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' \
    | grep -vE '^(10|127)\.|^169\.254\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[01])\.|^192\.0\.2\.' | head -n 1 || true
}
ip6() {
  ip -6 addr show scope global 2>/dev/null | awk '/inet6/ {sub(/\/.*/, "", $2); print $2}' | grep -viE '^f[cd]' | head -n 1 || true
}

# Zeigt die Domain schon auf diesen Server? (soweit der Server das selbst sehen kann)
points_here() {
  local ip mine
  if [ "$TUNNEL" = yes ]; then return 0; fi
  mine=" $(hostname -I 2>/dev/null) "
  for ip in $(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u); do
    case $mine in *" $ip "*) return 0 ;; esac
  done
  return 1
}

# ---------------------------------------------------------------
# Code-Ordner: der Webserver muss ihn lesen können (nicht z. B. in /root)
check_location() {
  case $CODE in
    *[[:space:]]*) fail "The code folder must not contain spaces: $CODE" ;;
  esac
  local target=$TARGET
  case $CODE in
    /tmp/*|/var/tmp/*|/dev/shm/*|/run/*)
      warn "$CODE is a temporary folder – the system may clear it." ;;
    *)
      if runuser -u "$WEB" -- test -r "$CODE/app/package.json" 2>/dev/null; then return 0; fi
      warn "The web server can’t read $CODE (folders like /root are private)." ;;
  esac
  case "$(choose "Copy the code to $target and continue there? [Y/n]" y)" in
    [nN]*) fail "Put the code into a folder like $target and run the installer from there." ;;
  esac
  [ ! -e "$target" ] || fail "$target already exists – run the installer from there: ${SUDO_HINT}bash $target/server/install.sh"
  install -d -m 755 /var/www
  cp -a "$CODE" "$target"
  info "Copied. Continuing from $target …"
  exec bash "$target/server/install.sh" "$@"
}

# ---------------------------------------------------------------
step_packages() {
  bold "1/9  Packages"
  local id
  # shellcheck source=/dev/null
  id=$(. /etc/os-release && echo "${ID:-}")
  case $id in
    ubuntu|debian) ;;
    *) fail "This installer is made for Ubuntu (22.04 or newer) and Debian (12 or newer)." ;;
  esac
  { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; } || fail "This server doesn’t use systemd."
  export DEBIAN_FRONTEND=noninteractive
  info "Installing Apache, Node.js, MariaDB and a few tools – the first time this takes a few minutes …"
  apt_update
  apt_install apache2 mariadb-server git curl unzip rsync openssl ca-certificates bind9-dnsutils jq
  # Node.js 22 (NodeSource) – dieselbe Installation wie für den Discord-Bot
  # shellcheck source=/dev/null
  . "${NODE_SH:-$CODE/server/node.sh}"
  node_ensure "$NODE_MAJOR" || fail "Node.js $NODE_MAJOR couldn’t be installed – see above."
  info "Apache $(apache2ctl -v 2>/dev/null | sed -n 's/^Server version: Apache\/\([0-9.]*\).*/\1/p'), Node.js $("$NODE" --version | tr -d v), MariaDB $(mariadb -N -e 'SELECT VERSION()' 2>/dev/null | cut -d- -f1)"
}
# ---------------------------------------------------------------
step_settings() {
  bold "2/9  Settings"
  local def
  def=$(conf_get DOMAIN)
  [ -n "$def" ] || def=$(cfg_get base_domain | cut -d: -f1)
  case $def in ""|*.test|localhost) def=on-your.site ;; esac
  while true; do
    prompt DOMAIN "Domain of the website, without www [$def]:"
    DOMAIN=$(printf '%s' "${DOMAIN:-$def}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$ ]]; then break; fi
    info "  Please enter a domain like on-your.site"
  done

  IMPORT="" IMP_CONFIG="" IMP_SMTP="" IMP_DUMP="" IMP_UPLOADS=""
  local dir_def=""
  if [ -z "$OLD_DOMAIN" ] && [ -d /root/import ]; then dir_def=/root/import; fi
  echo
  info "Moving from another server? Put these files from the old server into one folder (e.g. /root/import):"
  info "  config.php (or config.json), email/smtp.json, the database dump (.sql, .sql.gz or .zip) and the uploads ZIP"
  info "  (Admin → Storage & backups → Download all uploads). Step by step: server/README.md"
  while true; do
    prompt IMPORT "Folder with the files from the old server (empty = no import)${dir_def:+ [$dir_def]}:"
    IMPORT=${IMPORT:-$dir_def}
    case $IMPORT in no|none|-) IMPORT="" ;; esac
    IMPORT=${IMPORT%/}
    [ -n "$IMPORT" ] || return 0
    if [ ! -d "$IMPORT" ]; then info "  $IMPORT isn’t a folder."; continue; fi
    find_import "$IMPORT"
    if [ -z "$IMP_CONFIG$IMP_SMTP$IMP_DUMP$IMP_UPLOADS" ]; then info "  Nothing to import found in $IMPORT."; continue; fi
    if [ -n "$IMP_DUMP" ] && [ -z "$IMP_CONFIG" ]; then
      info "  The database needs the old config.php (or config.json) next to it: it holds the key for encrypted data (aes_key)."
      info "  Without it, encrypted data (Discord IDs, messages, booking requests) can’t be read. Please add it."
      continue
    fi
    info "Found in $IMPORT:"
    if [ -n "$IMP_CONFIG" ]; then info "  $(basename "$IMP_CONFIG")  – settings and the key for encrypted data"; fi
    if [ -n "$IMP_SMTP" ]; then info "  $(basename "$IMP_SMTP")  – mail server"; fi
    if [ -n "$IMP_DUMP" ]; then info "  $(basename "$IMP_DUMP")  – database"; fi
    if [ -n "$IMP_UPLOADS" ]; then info "  $(basename "$IMP_UPLOADS")  – uploads"; fi
    case "$(choose "Import these? [Y/n]" y)" in
      [nN]*) IMPORT="" IMP_CONFIG="" IMP_SMTP="" IMP_DUMP="" IMP_UPLOADS="" ;;
    esac
    return 0
  done
}

# Dateien im Import-Ordner anhand von Name und Inhalt erkennen
find_import() {
  local dir=$1 f
  IMP_CONFIG="" IMP_SMTP="" IMP_DUMP="" IMP_UPLOADS=""
  if [ -f "$dir/config.php" ]; then IMP_CONFIG=$dir/config.php; elif [ -f "$dir/config.json" ]; then IMP_CONFIG=$dir/config.json; fi
  for f in "$dir/smtp.json" "$dir/email/smtp.json"; do
    if [ -f "$f" ]; then IMP_SMTP=$f; break; fi
  done
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    case $f in
      *.sql|*.sql.gz)
        if [ -z "$IMP_DUMP" ]; then IMP_DUMP=$f; fi ;;
      *.zip)
        if unzip -Z1 "$f" 2>/dev/null | grep -qE '\.sql$'; then
          if [ -z "$IMP_DUMP" ]; then IMP_DUMP=$f; fi
        elif [ -z "$IMP_UPLOADS" ]; then
          IMP_UPLOADS=$f
        fi ;;
      *.tar.gz|*.tgz|*.tar)
        if [ -z "$IMP_UPLOADS" ]; then IMP_UPLOADS=$f; fi ;;
    esac
  done
  for f in "$dir/uploads" "$dir/oys-uploads"; do
    if [ -d "$f" ] && [ -z "$IMP_UPLOADS" ]; then IMP_UPLOADS=$f; fi
  done
}

# ---------------------------------------------------------------
step_database() {
  bold "3/9  Database"
  systemctl enable --now mariadb >/dev/null 2>&1 || systemctl start mariadb
  load_db_pass
  [[ $DB_PASS =~ ^[A-Za-z0-9]{24,}$ ]] || DB_PASS=$(openssl rand -hex 24)
  mariadb <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
  info "Database $DB_NAME with its own user is ready (only reachable from this server)."
  if [ "$(mariadb -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME'")" = 0 ]; then DB_EMPTY=1; fi
  if [ -n "$IMP_DUMP" ]; then import_dump "$IMP_DUMP"; fi
}

load_db_pass() {
  DB_PASS=""
  if [ "$(cfg_get db.user)" = "$DB_USER" ] && [ "$(cfg_get db.name)" = "$DB_NAME" ]; then
    DB_PASS=$(cfg_get db.pass)
  fi
}

dump_read() {
  case $1 in
    *.gz) gzip -dc -- "$1" ;;
    *.zip) unzip -p "$1" "$(unzip -Z1 "$1" | grep -m 1 -E '\.sql$')" ;;
    *) cat -- "$1" ;;
  esac
}

import_dump() {
  local file=$1 tables users
  tables=$(mariadb -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME'")
  if [ "$tables" -gt 0 ]; then
    warn "The database on this server already has $tables tables."
    case "$(choose "Replace everything in it with the database from the old server? [y/N]" n)" in
      [yY]*) ;;
      *) info "Database import skipped."; return 0 ;;
    esac
    mariadb -e "DROP DATABASE \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  fi
  info "Importing $(basename "$file") …"
  # shellcheck disable=SC2016
  # Nur die Tabellen: Datenbankname, alte Benutzer (DEFINER) und MySQL-8-Eigenheiten passen hier nicht
  if ! dump_read "$file" | sed -E \
      -e '/^(CREATE DATABASE|USE )/d' \
      -e '/^SET @@(GLOBAL\.GTID_PURGED|SESSION\.SQL_LOG_BIN)/d' \
      -e 's/DEFINER=`[^`]+`@`[^`]+`//g' \
      -e 's/utf8mb4_0900_ai_ci/utf8mb4_unicode_ci/g' | mariadb "$DB_NAME"; then
    fail "The import didn’t work – see the message above. Use a dump from Plesk (Databases → Export Dump), phpMyAdmin or mysqldump."
  fi
  tables=$(mariadb -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$DB_NAME'")
  users=$(mariadb -N "$DB_NAME" -e "SELECT COUNT(*) FROM users" 2>/dev/null || echo "?")
  DB_IMPORTED=1
  info "Imported $tables tables with $users accounts."
}

# ---------------------------------------------------------------
# config.json schreiben (app/scripts/config.mjs, ohne PHP): bisherige Werte bleiben – aus config.json, sonst aus der
# config.php der PHP-Version, beim Umzug die vom alten Server –, nur Datenbank, Domain und Upload-Ordner setzt der
# Installer; Schlüssel entstehen nur, wenn es noch keine gibt. Das Passwort kommt über die Umgebung (nicht in die
# Prozessliste). Atomar als root:www-data 0640; die vorige Fassung liegt in /etc/onyoursite/config.json.previous.
# write_config_json ZIEL [BISHERIGE-EINSTELLUNGEN] [IMPORT]
write_config_json() {
  local args=(write --file "$1" --domain "$DOMAIN" --uploads "$UPLOADS" --db-name "$DB_NAME" --db-user "$DB_USER")
  if [ -n "${2:-}" ]; then args+=(--current "$2"); fi
  if [ -n "${3:-}" ]; then args+=(--import "$3"); fi
  if ! OYS_DB_PASS=$DB_PASS "$NODE" "$CONFIG_MJS" "${args[@]}"; then
    fail "config.json couldn’t be written – see above."
  fi
}

import_uploads() {
  local src=$1 tmp="" dir count=0 f
  if [ -d "$src" ]; then
    dir=$src
  else
    # Auf derselben Platte auspacken wie die Uploads – /tmp liegt z. B. bei Debian 13 im Arbeitsspeicher
    tmp=$(mktemp -d "$DATA_DIR/.import.XXXXXX")
    # shellcheck disable=SC2064
    trap "rm -rf '$tmp'" EXIT
    case $src in
      *.zip) unzip -q "$src" -d "$tmp" ;;
      *.tar.gz|*.tgz) tar -xzf "$src" -C "$tmp" --no-same-owner ;;
      *.tar) tar -xf "$src" -C "$tmp" --no-same-owner ;;
    esac
    dir=$tmp
  fi
  # Bis zum Ordner mit den Dateien hinab (im ZIP aus dem Admin-Bereich: uploads/)
  while [ -z "$(find "$dir" -mindepth 1 -maxdepth 1 -type f ! -name '.*' -print -quit)" ] \
    && [ "$(find "$dir" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 1 ]; do
    dir=$(find "$dir" -mindepth 1 -maxdepth 1 -type d)
  done
  # Nur normale Dateien (keine Verknüpfungen, nichts Verstecktes)
  while IFS= read -r -d '' f; do
    if [ -n "$tmp" ]; then mv -f "$f" "$UPLOADS/"; else cp --preserve=timestamps "$f" "$UPLOADS/"; fi
    count=$((count + 1))
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -type f ! -name '.*' -print0)
  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
    trap - EXIT
  fi
  chown -R "$WEB:$WEB" "$UPLOADS"
  info "$count uploaded file$([ "$count" = 1 ] || echo s) copied to $UPLOADS"
}

# Port der Webseite hinter Apache (node_port in config.json, sonst 3000)
web_port() {
  local p
  p=$(cfg_get node_port "${1:-$(cfg_file)}")
  if [[ $p =~ ^[0-9]+$ ]] && [ "$p" -gt 0 ] && [ "$p" -lt 65536 ]; then printf '%s' "$p"; else printf '3000'; fi
}

# Apache: TLS, HTTP → HTTPS, unbekannte Namen 404 – und alles für die Domain geht an die Webseite (Node.js)
apache_site() {
  cat <<EOF2
# OnYourSite – written by server/install.sh (it rewrites this file when it runs again)
ServerName $DOMAIN
ServerTokens Prod
ServerSignature Off
TraceEnable Off
# Logs without IP addresses and without query strings
LogFormat "%{%Y-%m-%d %H:%M:%S}t %v \"%m %U %H\" %>s %O %{ms}T" onyoursite
ErrorLogFormat "[%{cu}t] [%-m:%l] %7F: %E: %M"

# Unknown addresses (e.g. the bare IP of the server) get nothing
<VirtualHost *:80>
    ServerName default.invalid
    Redirect 404 /
    CustomLog \${APACHE_LOG_DIR}/onyoursite-access.log onyoursite
</VirtualHost>
<VirtualHost *:443>
    ServerName default.invalid
    SSLEngine on
    SSLCertificateFile $SSL_DIR/fullchain.pem
    SSLCertificateKeyFile $SSL_DIR/privkey.pem
    Redirect 404 /
    CustomLog \${APACHE_LOG_DIR}/onyoursite-access.log onyoursite
</VirtualHost>

<VirtualHost *:80>
    ServerName $DOMAIN
    ServerAlias www.$DOMAIN *.$DOMAIN
    RewriteEngine On
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
    CustomLog \${APACHE_LOG_DIR}/onyoursite-access.log onyoursite
</VirtualHost>

<VirtualHost *:443>
    ServerName $DOMAIN
    ServerAlias www.$DOMAIN *.$DOMAIN
    Protocols h2 http/1.1
    # Uploads are at most 16 MB – bigger requests never reach the website
    LimitRequestBody 26214400

    SSLEngine on
    SSLProtocol -all +TLSv1.2 +TLSv1.3
    SSLCertificateFile $SSL_DIR/fullchain.pem
    SSLCertificateKeyFile $SSL_DIR/privkey.pem

    # Everything goes to the website (Node.js, service onyoursite-web) – the files in static/ too
    ProxyRequests Off
    ProxyPreserveHost On
    ProxyErrorOverride Off
    ProxyTimeout 300
    # The visitor's address (with the tunnel: after mod_remoteip). "set" replaces anything a visitor sent; the website
    # trusts this header only from this server and never trusts CF-Connecting-IP itself
    RequestHeader set X-OYS-Client-IP "expr=%{REMOTE_ADDR}"
    # nocanon: the address reaches the website exactly as it was sent; ttl stays below the keep-alive time of Node.js
    ProxyPass / http://127.0.0.1:$PORT/ nocanon retry=0 ttl=60 keepalive=On
    ErrorDocument 502 "OnYourSite is restarting - please try again in a few seconds."
    ErrorDocument 503 "OnYourSite is restarting - please try again in a few seconds."

    ErrorLog \${APACHE_LOG_DIR}/onyoursite-error.log
    CustomLog \${APACHE_LOG_DIR}/onyoursite-access.log onyoursite
</VirtualHost>
EOF2
}

# Apache-Datei schreiben (gilt erst nach dem Neuladen) und die nötigen Module einschalten; 0 = Datei geändert
write_apache() {
  local m changed=1
  if apache_site | write_if_changed "$SITE_CONF"; then changed=0; fi
  for m in /etc/apache2/mods-enabled/php*.load; do
    if [ -e "$m" ]; then a2dismod -q "$(basename "$m" .load)" >/dev/null; changed=0; fi
  done
  for m in mpm_prefork mpm_worker; do
    if [ -e "/etc/apache2/mods-enabled/$m.load" ]; then a2dismod -q "$m" >/dev/null; changed=0; fi
  done
  for m in mpm_event ssl rewrite headers http2 proxy proxy_http remoteip; do
    if [ ! -e "/etc/apache2/mods-enabled/$m.load" ]; then a2enmod -q "$m" >/dev/null; changed=0; fi
  done
  for m in 000-default default-ssl; do
    if [ -e "/etc/apache2/sites-enabled/$m.conf" ]; then a2dissite -q "$m" >/dev/null; changed=0; fi
  done
  if [ ! -e /etc/apache2/sites-enabled/onyoursite.conf ]; then a2ensite -q onyoursite >/dev/null; changed=0; fi
  return "$changed"
}

apache_check() {
  if ! apache2ctl configtest >/dev/null 2>&1; then
    apache2ctl configtest || true
    return 1
  fi
}

# Passt das Zertifikat zur Domain und zu ihren Subdomains?
cert_matches() {
  [ -s "$SSL_DIR/fullchain.pem" ] || return 1
  openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q "does match" \
    && openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -checkhost "check.$DOMAIN" 2>/dev/null | grep -q "does match"
}

# Vorläufiges Zertifikat, damit Apache startet, bis das echte da ist
cert_temporary() {
  [ -s "$SSL_DIR/fullchain.pem" ] || return 0
  [ "$(openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -issuer 2>/dev/null | sed 's/^issuer=//')" \
    = "$(openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -subject 2>/dev/null | sed 's/^subject=//')" ]
}

ensure_cert() {
  install -d -m 750 "$SSL_DIR"
  if [ ! -s "$SSL_DIR/privkey.pem" ] || [ ! -s "$SSL_DIR/fullchain.pem" ] \
    || ! cert_matches; then
    openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 90 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN" -addext "basicConstraints=critical,CA:FALSE" \
      -keyout "$SSL_DIR/privkey.pem" -out "$SSL_DIR/fullchain.pem" 2>/dev/null
    chmod 600 "$SSL_DIR/privkey.pem"
  fi
}

# ---------------------------------------------------------------
# Die Webseite (Node.js): bauen, Befehle, Dienst

# Upload-Ordner aus den Einstellungen (relativ = ab dem Code-Ordner, leer = static/uploads im Code)
uploads_dir() {
  local u
  u=$(cfg_get uploads_dir "${1:-$(cfg_file)}")
  case $u in
    "") u=$CODE/static/uploads ;;
    /*) ;;
    *) u=$CODE/$u ;;
  esac
  printf '%s' "${u%/}"
}

# Kennung eines Baus: Node-Version und alle Quellen – gleich = nichts neu zu bauen
build_stamp() {
  (cd "$1" && { "$NODE" --version; cat package.json package-lock.json tsconfig.json; find src scripts -type f -print0 | sort -z | xargs -0 cat; } | sha256sum | cut -d' ' -f1) 2>/dev/null || true
}

build_current() {
  [ -f "$1/dist/server.js" ] && [ -d "$1/node_modules" ] && [ "$(cat "$1/dist/.oys-build" 2>/dev/null)" = "$(build_stamp "$1")" ]
}

# app/ bauen: Pakete genau nach package-lock.json (fertige Programme, keine Skripte), TypeScript übersetzen, die Pakete
# für die Entwicklung wieder weg, dann prüfen, ob sharp und canvas auf diesem Server laufen. Etwa 300 MB Speicher.
build_app() {
  local dir=$1 log
  if [ "${2:-}" != force ] && build_current "$dir"; then
    info "The website is already built for this version."
    return 0
  fi
  info "Building the website (npm ci and TypeScript) – this takes a minute or two …"
  log=$(mktemp)
  # tsc übersetzt nur TypeScript – Daten wie src/data/blacklist.json kommen mit find/cp in dieselben Ordner von dist/
  if ! (cd "$dir" && export PATH="$NODE_BIN:$PATH" && rm -rf dist \
      && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error \
      && npm run build --silent \
      && (cd src && find . -type f ! -name '*.ts' ! -name '*.js' -exec cp --parents {} ../dist/ \;) \
      && npm prune --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) >"$log" 2>&1; then
    tail -n 30 "$log" | sed 's/^/    /'
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  if ! runuser -u "$WEB" -- "$NODE" "$dir/dist/cli.js" check --native | sed 's/^/  /'; then
    return 1
  fi
  build_stamp "$dir" > "$dir/dist/.oys-build"
}

# Befehle der Webseite als Webserver-Benutzer: app_cli CODE-ORDNER EINSTELLUNGEN BEFEHL …
app_cli() {
  local dir=$1 cfg=$2
  shift 2
  runuser -u "$WEB" -- env OYS_CONFIG="$cfg" NODE_ENV=production "$NODE" "$dir/app/dist/cli.js" "$@"
}

# Dienst onyoursite-web: Node.js als www-data, nur 127.0.0.1. Schreiben darf er nur in den Upload-Ordner, in seinen
# Ordner für Zwischendateien (große ZIP-Sicherungen, nicht im Arbeitsspeicher) und in email/ (Mail-Einstellungen
# aus dem Admin-Bereich) – der Rest des Systems ist für ihn nur lesbar. 0 = Datei geändert
write_web_unit() {
  local uploads
  uploads=$(uploads_dir "${1:-}")
  install -d -m 750 -o "$WEB" -g "$WEB" "$uploads"
  install -d -m 700 -o "$WEB" -g "$WEB" "$DATA_DIR/tmp"
  write_if_changed "$WEB_UNIT" <<EOF2
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite website (Node.js)
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
Type=simple
User=$WEB
Group=$WEB
WorkingDirectory=$CODE/app
Environment=NODE_ENV=production TMPDIR=$DATA_DIR/tmp
ExecStart=$NODE $CODE/app/dist/server.js
Restart=always
RestartSec=2
TimeoutStopSec=30
UMask=0022
# Writable: the uploads, its own folder for temporary files and email/ (mail settings) – nothing else
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ReadWritePaths=$uploads $DATA_DIR/tmp $CODE/email
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
# No MemoryDenyWriteExecute: the JavaScript engine needs to write its compiled code
MemoryMax=1G
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF2
}

# Antwortet die Webseite auf 127.0.0.1? Höchstens WEB_WAIT Sekunden (60, nach der Uhr – eine Version, die Verbindungen
# annimmt, aber nicht antwortet, hält sonst jeden Versuch 5 Sekunden auf), alle 0,2 Sekunden gefragt. Stürzt der Dienst
# dabei ab (systemd startet ihn neu und zählt mit), ist sofort Schluss – sonst wartete ein Update auf eine Version, die
# nie antwortet, und die Seite bliebe so lange weg.
wait_web() {
  local code r0 r end=$((SECONDS + ${WEB_WAIT:-60}))
  r0=$(systemctl show -p NRestarts --value onyoursite-web 2>/dev/null || true)
  while [ "$SECONDS" -lt "$end" ]; do
    code=$(curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" "http://127.0.0.1:$PORT/" 2>/dev/null || true)
    if [ "$code" = 200 ]; then return 0; fi
    r=$(systemctl show -p NRestarts --value onyoursite-web 2>/dev/null || true)
    if [[ $r0 =~ ^[0-9]+$ && $r =~ ^[0-9]+$ ]] && [ "$r" -gt "$r0" ]; then return 1; fi
    sleep 0.2
  done
  return 1
}

web_log() {
  journalctl -u onyoursite-web -n "${1:-30}" --no-pager 2>/dev/null | sed 's/^/    /' || true
}

# Besitzer und Rechte im Code-Ordner: alles gehört root und ist lesbar, schreiben darf der Webserver nur in email/
fix_permissions() {
  chown -R root:root "$CODE"
  find "$CODE" \( -path "$CODE/config.json" -o -path "$CODE/config.php" -o -path "$CODE/email" -o -path "$CODE/app/node_modules" \
    -o -name '.env' -o -name '.env.*' \) -prune -o ! -type l -exec chmod go+rX,go-w {} +
  if [ -f "$CODE/config.json" ]; then chown root:"$WEB" "$CODE/config.json"; chmod 640 "$CODE/config.json"; fi
  chown -R "$WEB:$WEB" "$CODE/email"
  chmod 750 "$CODE/email"
  # email/ gehört dem Webserver: nur eine echte Datei anfassen, nie einem Symlink folgen
  if [ -f "$CODE/email/smtp.json" ] && [ ! -L "$CODE/email/smtp.json" ]; then chmod 640 "$CODE/email/smtp.json"; fi
}

# ---------------------------------------------------------------
# PHP (Version 2.x): läuft die Seite hier noch damit? Apache gibt dann .php-Dateien an PHP-FPM.
php_live() {
  [ -f "$SITE_CONF" ] && grep -qE 'proxy:unix:[^|]*php[^|]*fpm' "$SITE_CONF"
}

# Code-Ordner für Apache sperren: Apache-Prozesse, die beim Umzug noch die Einstellung der PHP-Version haben, lesen diese
# .htaccess bei jeder Anfrage und geben danach nichts mehr aus dem Code-Ordner aus (die Webseite selbst läuft über
# Node.js). Bleibt danach liegen. Eine vorhandene fremde .htaccess (Code ohne git kopiert) kommt beim Zurückgehen wieder.
DENY_MARK="# OnYourSite – written by server/install.sh: nothing in this folder is served directly"
deny_code_folder() {
  if [ -f "$CODE/.htaccess" ] && ! grep -qxF "$DENY_MARK" "$CODE/.htaccess"; then
    install -d -m 750 -o root -g "$WEB" "$DATA_DIR" "$DATA_DIR/next"
    cp -p "$CODE/.htaccess" "$DATA_DIR/next/htaccess.previous"
  fi
  printf '%s\n' "$DENY_MARK" "# The website runs on Node.js (service onyoursite-web); Apache passes every request on to it." \
    "Require all denied" > "$CODE/.htaccess.new"
  chmod 644 "$CODE/.htaccess.new"
  mv -f "$CODE/.htaccess.new" "$CODE/.htaccess"
}
# Nur beim Zurückgehen (revert_release über on_exit)
# shellcheck disable=SC2317
undeny_code_folder() {
  if [ -f "$DATA_DIR/next/htaccess.previous" ]; then
    mv -f "$DATA_DIR/next/htaccess.previous" "$CODE/.htaccess"
  elif [ -f "$CODE/.htaccess" ] && grep -qxF "$DENY_MARK" "$CODE/.htaccess"; then
    rm -f "$CODE/.htaccess"
  fi
}

# Braucht auf diesem Server noch etwas anderes PHP? Andere Apache-Seiten oder -Einstellungen mit PHP (PHP-FPM, mod_php,
# z. B. phpMyAdmin) oder eigene PHP-FPM-Pools neben „www“. Ausgabe: die Fundstellen, eine je Zeile.
php_used_elsewhere() {
  local f
  for f in /etc/apache2/sites-enabled/* /etc/apache2/conf-enabled/*; do
    [ -e "$f" ] || continue
    [ "$(readlink -f "$f")" != "$(readlink -f "$SITE_CONF")" ] || continue
    # php…-fpm.conf von Debian gibt .php-Dateien überall an PHP-FPM – das allein heißt noch nicht, dass sie jemand nutzt
    case $(basename "$f") in php*-fpm.conf) continue ;; esac
    if grep -qsiE 'proxy:unix:[^|"]*php|fcgi://[^[:space:]"]*php|php_(admin_)?(value|flag)[[:space:]]|application/x-httpd-php' "$f"; then
      printf '%s\n' "$f"
    fi
  done
  for f in /etc/php/*/fpm/pool.d/*.conf; do
    if [ -e "$f" ] && [ "$(basename "$f")" != www.conf ]; then printf '%s\n' "$f"; fi
  done
}

# Nach dem Umzug auf Node.js: die PHP-Einstellungen der Seite weg, config.php nur noch als Kopie für root, PHP-FPM aus
# und auf Wunsch die PHP-Pakete entfernen – außer andere Websites auf diesem Server brauchen PHP noch.
retire_php() {
  local f units=() u others
  others=$(php_used_elsewhere)
  rm -f /etc/php/*/fpm/conf.d/90-onyoursite.ini
  if [ -n "$others" ]; then
    # PHP-FPM bleibt für die anderen; neu laden, damit die Einstellungen von OnYourSite nicht mehr gelten
    if [ -n "${PHPV:-}" ] && systemctl is-active --quiet "php$PHPV-fpm"; then systemctl reload "php$PHPV-fpm" || true; fi
  else
    if [ -n "${PHPV:-}" ]; then units+=("php$PHPV-fpm"); fi
    for f in /lib/systemd/system/php*-fpm.service /usr/lib/systemd/system/php*-fpm.service /etc/systemd/system/php*-fpm.service; do
      if [ -e "$f" ]; then units+=("$(basename "$f" .service)"); fi
    done
    if [ "${#units[@]}" -gt 0 ]; then
      for u in $(printf '%s\n' "${units[@]}" | sort -u); do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
    fi
  fi
  # proxy_fcgi brauchte nur PHP – abschalten, wenn nichts anderes in Apache es nutzt. -R folgt den Verknüpfungen in
  # sites-enabled/conf-enabled (-r übersähe sie, und eine andere PHP-Seite gäbe danach ihren Quelltext aus)
  if [ -e /etc/apache2/mods-enabled/proxy_fcgi.load ] && ! grep -RqsE 'proxy:unix|fcgi://' /etc/apache2/sites-enabled/ /etc/apache2/conf-enabled/; then
    a2dismod -q proxy_fcgi >/dev/null 2>&1 || true
    systemctl reload apache2 || true
  fi
  if [ -f "$CODE/config.php" ]; then
    install -d -m 700 "$CONF_DIR"
    install -m 600 "$CODE/config.php" "$CONF_DIR/config.php.previous"
    rm -f "$CODE/config.php"
  fi
  rm -f "$PREVIOUS_SITE"
  if [ -n "$others" ]; then
    info "OnYourSite doesn’t need PHP any more; its PHP settings are gone (config.php: copy in $CONF_DIR/config.php.previous, root only)."
    info "PHP-FPM stays on – other websites on this server use PHP:"
    printf '%s\n' "$others" | sed 's/^/    /'
    return 0
  fi
  info "PHP-FPM is off and the PHP settings of the website are gone (config.php: copy in $CONF_DIR/config.php.previous, root only)."
  offer_php_purge
}

# Die PHP-Pakete (php…, libapache2-mod-php…) – entfernen nur, wenn sonst nichts davon abhängt
offer_php_purge() {
  local pkgs extra
  pkgs=$(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 'php*' 'libapache2-mod-php*' 2>/dev/null \
    | awk '$1 ~ /^.i/ {print $2}' | grep -E '^(php([0-9.]+)?(-|$)|libapache2-mod-php)' | paste -sd' ' - || true)
  [ -n "$pkgs" ] || return 0
  # shellcheck disable=SC2086
  extra=$(apt-get -s purge $pkgs 2>/dev/null | awk '/^(Purg|Remv) / {print $2}' \
    | grep -vE '^(php([0-9.]+)?(-|$)|libapache2-mod-php)' | paste -sd' ' - || true)
  if [ -n "$extra" ]; then
    info "PHP isn’t needed by OnYourSite any more. It stays installed because other software uses it: $extra"
    return 0
  fi
  echo
  info "PHP isn’t needed any more: $pkgs"
  case "$(choose "Remove these PHP packages now? [Y/n]" y)" in
    [nN]*) info "They stay. To remove them later: ${SUDO_HINT}apt purge $pkgs" ;;
    *)
      # shellcheck disable=SC2086
      if apt-get -o DPkg::Lock::Timeout=600 purge -y -qq $pkgs >/dev/null 2>&1; then
        info "PHP is removed."
      else
        warn "PHP couldn’t be removed – try it by hand: ${SUDO_HINT}apt purge $pkgs"
      fi ;;
  esac
}

step_website() {
  bold "4/9  Website"
  local cfg_from="" restart=0 pending=0 old_cfg=""
  # Der Code gehört root – Root-Timer und Updates laufen aus diesem Ordner
  chown -R root:root "$CODE"
  if [ -n "$IMP_CONFIG" ]; then
    # Die Schlüssel der alten Einstellungen gehören zu ihrer Datenbank
    if [ "$DB_IMPORTED" = 1 ] || [ "$DB_EMPTY" = 1 ]; then
      cfg_from=$IMP_CONFIG
    else
      warn "The old $(basename "$IMP_CONFIG") isn’t used: its keys belong to its database, which wasn’t imported."
    fi
  fi
  if [ -f "$CODE/config.json" ]; then old_cfg=$(cat "$CODE/config.json"); fi
  write_config_json "$CODE/config.json" "" "$cfg_from"
  if [ "$(cat "$CODE/config.json")" != "$old_cfg" ]; then restart=1; fi
  info "config.json is written (readable only by root and the web server)."
  install -d -m 750 -o root -g "$WEB" "$DATA_DIR"
  install -d -m 750 -o "$WEB" -g "$WEB" "$UPLOADS"
  install -d -m 700 -o "$WEB" -g "$WEB" "$DATA_DIR/tmp"
  fix_permissions
  if [ -n "$IMP_SMTP" ]; then
    rm -f "$CODE/email/smtp.json"
    install -m 640 -o "$WEB" -g "$WEB" "$IMP_SMTP" "$CODE/email/smtp.json"
    info "Mail server settings (smtp.json) copied."
  fi
  if [ -n "$IMP_UPLOADS" ]; then import_uploads "$IMP_UPLOADS"; fi
  if ! build_current "$CODE/app"; then
    build_app "$CODE/app" || fail "The website couldn’t be built – see above."
    restart=1
  fi
  # Datenbank auf den Stand dieser Version – gibt es schon Daten, vorher eine Sicherung
  app_cli "$CODE" "$CODE/config.json" migrate --pending >/dev/null || pending=$?
  if [ "$pending" = 2 ] && [ "$DB_EMPTY" != 1 ] && [ "$DB_IMPORTED" != 1 ] && [ -f "$CONF" ]; then
    bash "$CODE/server/backup.sh" before-update || fail "The backup didn’t work – the database wasn’t changed."
  fi
  app_cli "$CODE" "$CODE/config.json" migrate | sed 's/^/  /' || fail "The database couldn’t be prepared – see above."
  # Eingespielte Datenbank: liest der Schlüssel aus den alten Einstellungen ihre verschlüsselten Werte? (nur lesend –
  # eine config.php von einem anderen Server fiele sonst erst auf, wenn Nachrichten und Discord-IDs unlesbar sind)
  if [ "$DB_IMPORTED" = 1 ] && ! app_cli "$CODE" "$CODE/config.json" check --crypto | sed 's/^/  /'; then
    warn "The key (aes_key) in the old $(basename "${IMP_CONFIG:-config.php}") doesn’t read the encrypted data of the imported database."
    warn "Is it from the same server as the database dump? The website runs, but these values stay unreadable until"
    warn "the right file is imported: ${SUDO_HINT}bash $CODE/server/install.sh"
  fi
  PORT=$(web_port)
  if write_web_unit; then restart=1; fi
  systemctl daemon-reload
  systemctl enable onyoursite-web >/dev/null 2>&1
  if [ "$restart" = 1 ] || ! systemctl is-active --quiet onyoursite-web; then systemctl restart onyoursite-web; fi
  if ! wait_web; then
    web_log 30
    fail "The website doesn’t start – see its log above (journalctl -u onyoursite-web)."
  fi
  write_apache || true
  ensure_cert
  systemctl enable apache2 >/dev/null 2>&1
  apache_check || fail "The Apache configuration has an error (see above)."
  if systemctl is-active --quiet apache2; then systemctl reload apache2; else systemctl restart apache2; fi
  info "The website runs with Node.js $("$NODE" --version | tr -d v) behind Apache – uploads: $UPLOADS"
}

# ---------------------------------------------------------------
# Zugangsdaten je DNS-Anbieter: VARIABLE|Beschriftung|secret, plain oder optional
provider_vars() {
  case $1 in
    dns_cf)
      echo "CF_Token|API token (Cloudflare → My Profile → API Tokens → template 'Edit zone DNS'):|secret"
      echo "CF_Zone_ID|Zone ID (overview page of the domain in Cloudflare, bottom right):|plain" ;;
    dns_hetznercloud)
      echo "HETZNER_TOKEN|API token (Hetzner Console → your project → Security → API tokens, Read & Write):|secret" ;;
    dns_ionos)
      echo "IONOS_PREFIX|API key prefix (developer.hosting.ionos.de → create an API key):|plain"
      echo "IONOS_SECRET|API key secret:|secret" ;;
    dns_netcup)
      echo "NC_Apikey|API key (customer control panel → Master Data → API):|secret"
      echo "NC_Apipw|API password (only for the old CCP API key, else empty):|optional"
      echo "NC_CID|Customer number (only for the old CCP API key, else empty):|optional" ;;
    dns_inwx)
      echo "INWX_User|INWX username:|plain"
      echo "INWX_Password|INWX password:|secret"
      echo "INWX_Shared_Secret|Two-factor secret (only with 2FA, else empty):|optional" ;;
    dns_kas)
      echo "KAS_Login|KAS login (e.g. w0123456):|plain"
      echo "KAS_Authdata|KAS password:|secret" ;;
    dns_porkbun)
      echo "PORKBUN_API_KEY|API key (porkbun.com → Account → API Access):|secret"
      echo "PORKBUN_SECRET_API_KEY|Secret API key:|secret" ;;
  esac
}

install_acme() {
  if [ -x "$ACME" ]; then return 0; fi
  local tmp
  info "Installing acme.sh, the Let’s Encrypt client …"
  # Der Installer packt im aktuellen Ordner aus – darum in einem eigenen, leeren Ordner
  tmp=$(mktemp -d)
  (cd "$tmp" && curl -fsSL https://raw.githubusercontent.com/acmesh-official/acme.sh/master/acme.sh \
    | sh -s -- --install-online --nocron --home "$ACME_HOME") >/dev/null 2>&1 || true
  rm -rf "$tmp"
  if [ ! -x "$ACME" ]; then warn "acme.sh couldn’t be installed (no connection to github.com?)."; return 1; fi
}

# Wo liegt das DNS? Anhand der Nameserver der Domain – Nummer in PROVIDERS, sonst nichts
dns_guess() {
  local ns
  ns=$(dig +short NS "$DOMAIN" 2>/dev/null | tr '[:upper:]' '[:lower:]' | paste -sd' ' - || true)
  case $ns in
    *ns.cloudflare.com*) echo 1 ;;
    *ns.hetzner.com*|*ns.hetzner.de*) echo 2 ;;
    *ui-dns.*) echo 3 ;;
    *netcup.net*) echo 4 ;;
    *inwx.*) echo 5 ;;
    *kasserver.com*) echo 6 ;;
    *porkbun.com*) echo 7 ;;
  esac
}

cert_until() {
  date -d "$(openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -enddate | cut -d= -f2)" +%Y-%m-%d 2>/dev/null || echo "?"
}

step_https() {
  local force=${1:-} hook="" name n=1 choice i=1 var label kind value creds=() rc=0 args extra lines line guess def
  bold "6/9  HTTPS certificate"
  # Neue Domain: das alte acme.sh-Zertifikat würde bei seiner Erneuerung die Dateien des neuen überschreiben
  if [ -n "$OLD_DOMAIN" ] && [ "$OLD_DOMAIN" != "$DOMAIN" ] && [ -x "$ACME" ] && [ -d "$ACME_HOME/${OLD_DOMAIN}_ecc" ]; then
    "$ACME" --remove -d "$OLD_DOMAIN" --ecc --home "$ACME_HOME" >/dev/null 2>&1 || true
    info "The certificate of the old domain $OLD_DOMAIN won’t be renewed any more."
  fi
  if [ -z "$force" ] && ! cert_temporary && cert_matches; then
    info "The certificate for $DOMAIN and *.$DOMAIN is in place (valid until $(cert_until), renews by itself)."
    return 0
  fi
  info "Profiles live at name.$DOMAIN, so the certificate has to cover all subdomains (*.$DOMAIN)."
  info "Let’s Encrypt only issues that after a check in the DNS. The installer does it through the API"
  info "of the company where the DNS of $DOMAIN is managed – usually where you bought the domain."
  echo
  info "Where is the DNS of $DOMAIN managed?"
  while IFS='|' read -r name _; do
    info "  $n) $name"
    n=$((n + 1))
  done <<< "$PROVIDERS"
  info "  $n) Another provider (acme.sh supports more than 150)"
  info "  $((n + 1))) Later – use a temporary certificate for now"
  guess=$(dns_guess)
  def=$((n + 1))
  if [ -n "$guess" ]; then
    def=$guess
    info "By its nameservers, the DNS of $DOMAIN is at $(sed -n "${guess}p" <<< "$PROVIDERS" | cut -d'|' -f1) – Enter picks it."
  fi
  while true; do
    choice=$(choose "Choose 1–$((n + 1)) [$def]:" "$def")
    if [[ $choice =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le $((n + 1)) ]; then break; fi
  done
  if [ "$choice" -eq $((n + 1)) ]; then
    info "Keeping the temporary certificate. Browsers will warn until the real one is there:"
    info "  ${SUDO_HINT}bash $CODE/server/install.sh --https"
    return 0
  fi
  if [ "$choice" -lt "$n" ]; then
    while IFS='|' read -r name hook; do
      if [ "$i" -eq "$choice" ]; then break; fi
      i=$((i + 1))
    done <<< "$PROVIDERS"
  fi
  if [ "$hook" = dns_cf ] && [ -s "$CF_ENV" ] && cf_saved_zone; then
    # Dasselbe Token wie für den Tunnel – es darf die DNS-Einträge ändern
    creds=("CF_Token=$CF_TOKEN" "CF_Zone_ID=$ZONE_ID")
    info "Using the Cloudflare token from the tunnel setup."
  elif [ "$choice" -lt "$n" ]; then
    info "$name: create an API access in your account there and paste the values (they aren’t shown)."
    # Erst einlesen, dann fragen – die Antworten kommen von der Tastatur, nicht aus der Liste
    mapfile -t lines < <(provider_vars "$hook")
    for line in "${lines[@]}"; do
      IFS='|' read -r var label kind <<< "$line"
      while true; do
        if [ "$kind" = plain ]; then prompt value "$label"; else prompt value "$label" hidden; fi
        value=$(printf '%s' "$value" | tr -d '[:space:]')
        if [ -n "$value" ] || [ "$kind" = optional ]; then break; fi
      done
      if [ -n "$value" ]; then creds+=("$var=$value"); fi
    done
    if [ "$hook" = dns_kas ]; then creds+=("KAS_Authtype=plain"); fi
  else
    info "Find your provider on github.com/acmesh-official/acme.sh/wiki/dnsapi (and dnsapi2):"
    info "it shows the name of the module (e.g. dns_gd) and the values it needs."
    while true; do
      prompt hook "Module name (dns_…):"
      if [[ $hook =~ ^dns_[a-z0-9_]+$ ]]; then break; fi
    done
    while true; do
      prompt var "Name of a value, e.g. GD_Key (empty = done):"
      [ -n "$var" ] || break
      if [[ ! $var =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then info "  Only letters, digits and _."; continue; fi
      prompt value "Value of $var:" hidden
      creds+=("$var=$value")
    done
  fi

  if ! install_acme; then
    info "The website keeps the temporary certificate until then. Try again: ${SUDO_HINT}bash $CODE/server/install.sh --https"
    return 0
  fi
  args=(--issue --dns "$hook" -d "$DOMAIN" -d "*.$DOMAIN" --server "${OYS_ACME_SERVER:-letsencrypt}" --keylength ec-256 --home "$ACME_HOME")
  # Nur für Tests mit einem eigenen ACME-Testserver
  if [ -n "${OYS_ACME_ARGS:-}" ]; then
    read -ra extra <<< "$OYS_ACME_ARGS"
    args+=("${extra[@]}")
  fi
  if [ -n "$force" ]; then args+=(--force); fi
  info "Asking Let’s Encrypt – this takes a few minutes while the DNS entry spreads …"
  # Zugangsdaten über die Umgebung (export), nicht als Argumente – die stünden in der Prozessliste
  (
    for c in "${creds[@]}"; do
      # shellcheck disable=SC2163
      export "$c"
    done
    "$ACME" "${args[@]}"
  ) || rc=$?
  if { [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; } \
    || ! "$ACME" --install-cert -d "$DOMAIN" --ecc --home "$ACME_HOME" \
      --key-file "$SSL_DIR/privkey.pem" --fullchain-file "$SSL_DIR/fullchain.pem" --reloadcmd "systemctl reload apache2"; then
    warn "The certificate couldn’t be created. Check the API access (and that the DNS of $DOMAIN is really managed there)."
    info "The website keeps the temporary certificate until then. Try again: ${SUDO_HINT}bash $CODE/server/install.sh --https"
    return 0
  fi
  chmod 600 "$SSL_DIR/privkey.pem"
  info "Certificate for $DOMAIN and *.$DOMAIN is installed (valid until $(cert_until))."
  info "It covers every subdomain – also the ones added later – and renews by itself about 30 days before it ends."
  info "If a renewal ever fails, all admins get an email two weeks before it runs out."
}

# ---------------------------------------------------------------
# Cloudflare-Tunnel: Besucher kommen über Cloudflare herein, der Server braucht keine offenen Web-Ports und seine
# IP bleibt verborgen. Der Installer legt den Tunnel über die API an, stellt die DNS-Einträge von @, www und * auf
# ihn um und räumt alte Tunnel und Einträge dieser Website ab – Mail-Einträge (MX, TXT), andere Namen und Tunnel,
# die auch etwas anderes bedienen, bleiben.

# cf METHODE PFAD [JSON] – gibt .result aus; bei einem Fehler steht die Meldung von Cloudflare in $(cf_err).
# (cf läuft meist in $( ) – eine dort gesetzte Variable käme nicht zurück, darum eine Datei.)
# Das Token geht über stdin an curl, nicht über die Befehlszeile (dort stünde es in der Prozessliste).
CF_ERRFILE=""
cf_err() {
  if [ -n "$CF_ERRFILE" ]; then cat "$CF_ERRFILE" 2>/dev/null; fi
}
cf() {
  local out CF_ERR=""
  if [ -z "$CF_ERRFILE" ]; then return 1; fi
  # printf ist in bash eingebaut – das Token taucht in keiner Prozessliste auf
  out=$(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$CF_TOKEN" \
    | curl -sS --max-time 30 -X "$1" "$CF_API$2" ${3:+--data "$3"} -K - 2>&1) \
    || { printf '%s' "Cloudflare can’t be reached: $out" > "$CF_ERRFILE"; return 1; }
  # Manche Antworten (z. B. beim Löschen eines DNS-Eintrags) haben kein „success“ – dann zählt ein Ergebnis ohne Fehler
  if ! jq -e '(.success == true) or ((.success == null) and (.result != null) and (((.errors // []) | length) == 0))' <<< "$out" >/dev/null 2>&1; then
    CF_ERR=$(jq -r '[.errors[]? | "\(.message) (\(.code))"] | join("; ")' <<< "$out" 2>/dev/null || true)
    printf '%s' "${CF_ERR:-$out}" > "$CF_ERRFILE"
    return 1
  fi
  : > "$CF_ERRFILE"
  jq -c '.result' <<< "$out"
}

# Fehler beim Ändern: fehlt dem gespeicherten Token ein Recht, wird es vergessen – beim nächsten Lauf fragt der Installer neu
cf_fail() {
  local e again="${SUDO_HINT}bash $CODE/server/install.sh"
  e=$(cf_err)
  # --tunnel geht erst nach der ersten fertigen Einrichtung und nimmt die Domain aus server.conf – beim ersten Mal
  # oder nach einem Domainwechsel den Installer einfach neu starten
  if [ -n "$OLD_DOMAIN" ] && [ "$OLD_DOMAIN" = "$DOMAIN" ]; then again="$again --tunnel"; fi
  if grep -qiE 'authenticat|permission|unauthori|forbidden|\(10000\)|\(9109\)' <<< "$e"; then
    rm -f "$CF_ENV"
    fail "$1: $e. The token is missing a permission (Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone · Read) – create a new one and run: $again"
  fi
  fail "$1: $e"
}

# in_list WERT EINTRAG… – steht WERT in der Liste?
in_list() {
  local x n=$1
  shift
  for x in "$@"; do
    if [ "$x" = "$n" ]; then return 0; fi
  done
  return 1
}

# Einen Wert sofort in server.conf speichern (z. B. die Tunnel-ID, damit ein Abbruch nichts verliert)
conf_set() {
  install -d -m 700 "$CONF_DIR"
  if [ ! -f "$CONF" ]; then (umask 077 && : > "$CONF"); fi
  if grep -q "^$1=" "$CONF"; then sed -i "s|^$1=.*|$1=$2|" "$CONF"; else echo "$1=$2" >> "$CONF"; fi
}

# Gespeichertes Token laden und die Zone der Domain finden (ohne Rückfrage) – für das Zertifikat
cf_saved_zone() {
  local z
  apt_install jq curl
  if [ -z "$CF_ERRFILE" ]; then
    CF_ERRFILE=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$CF_ERRFILE'" EXIT
  fi
  CF_TOKEN=$(sed -n 's/^CF_API_TOKEN=//p' "$CF_ENV" | tail -n 1)
  z=$(cf GET "/zones?name=$DOMAIN") || return 1
  ZONE_ID=$(jq -r '.[0].id // empty' <<< "$z")
  [ -n "$ZONE_ID" ]
}

# API-Token prüfen und Zone + Konto finden; fragt nach einem Token, bis eines passt (Enter = abbrechen)
cf_login() {
  local z shown=0
  CF_TOKEN=""
  if [ -f "$CF_ENV" ]; then CF_TOKEN=$(sed -n 's/^CF_API_TOKEN=//p' "$CF_ENV" | tail -n 1); fi
  while true; do
    if [ -n "$CF_TOKEN" ]; then
      if z=$(cf GET "/zones?name=$DOMAIN") && [ "$(jq 'length' <<< "$z")" -gt 0 ]; then
        ZONE_ID=$(jq -r '.[0].id' <<< "$z")
        ACC_ID=$(jq -r '.[0].account.id' <<< "$z")
        ZONE_STATUS=$(jq -r '.[0].status // "active"' <<< "$z")
        if cf GET "/accounts/$ACC_ID/cfd_tunnel?is_deleted=false&per_page=1" >/dev/null; then break; fi
        info "  This token can’t manage tunnels ($(cf_err))."
      else
        if [ -n "$(cf_err)" ]; then info "  Cloudflare says: $(cf_err)"; else info "  $DOMAIN isn’t in the Cloudflare account of this token."; fi
      fi
    fi
    if [ "$shown" = 0 ]; then
      info "The installer needs an API token from Cloudflare: My Profile → API Tokens → Create Token →"
      info "Create Custom Token, with these permissions (each set to Edit or Read as shown):"
      info "  Account · Cloudflare Tunnel · Edit"
      info "  Zone · DNS · Edit"
      info "  Zone · Zone · Read"
      info "Account Resources: your account – Zone Resources: Specific zone → $DOMAIN."
      info "The token is typed in hidden and stays on this server (/etc/onyoursite/cloudflare.env, only root)."
      shown=1
    fi
    prompt CF_TOKEN "Cloudflare API token (Enter = cancel):" hidden
    CF_TOKEN=$(printf '%s' "$CF_TOKEN" | tr -d '[:space:]')
    [ -n "$CF_TOKEN" ] || return 1
    # Der „Global API Key“ ist kein Token: er darf alles und braucht zusätzlich die E-Mail-Adresse
    if [[ $CF_TOKEN == cfk_* ]] || [[ $CF_TOKEN =~ ^[0-9a-f]{37}$ ]]; then
      info "  That is the Global API Key – please create an API token instead (Create Token, as above)."
      CF_TOKEN=""
    fi
  done
  install -d -m 700 "$CONF_DIR"
  (umask 077 && printf 'CF_API_TOKEN=%s\n' "$CF_TOKEN" > "$CF_ENV")
}

# Was auf dem Server zum Tunnel gehört: cloudflared, eigener Dienst, echte Besucher-IP, Anfragen an sich selbst lokal.
# Der Dienst startet nur neu, wenn sich etwas geändert hat – sonst wären Besucher bei jedem Update kurz ausgesperrt.
tunnel_local() {
  local bin before after restart=${1:-0}
  if ! command -v cloudflared >/dev/null 2>&1; then
    info "Installing cloudflared (pkg.cloudflare.com) …"
    install -d -m 755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      > /etc/apt/sources.list.d/cloudflared.list
    apt_update
  fi
  before=$(cloudflared --version 2>/dev/null || true)
  apt_install cloudflared
  bin=$(command -v cloudflared)
  after=$("$bin" --version 2>/dev/null || true)
  if [ "$before" != "$after" ]; then restart=1; fi
  if write_if_changed "$TUNNEL_UNIT" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite Cloudflare tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# TUNNEL_TOKEN comes from this file (only root can read it), not from the command line
EnvironmentFile=$TUNNEL_ENV
ExecStart=$bin --no-autoupdate tunnel run
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryMax=256M

[Install]
WantedBy=multi-user.target
EOF
  then
    restart=1
  fi
  systemctl daemon-reload
  systemctl enable onyoursite-tunnel >/dev/null 2>&1
  if [ "$restart" = 1 ] || ! systemctl is-active --quiet onyoursite-tunnel; then
    systemctl restart onyoursite-tunnel
  fi
  # Die Webseite soll die echte Besucher-IP sehen (Spam-Bremse, Anmeldeschutz) – vertraut wird nur cloudflared auf
  # diesem Server; Apache gibt sie im Kopf X-OYS-Client-IP an Node.js weiter
  if printf '%s\n' "# OnYourSite – written by server/install.sh: real visitor IP from the Cloudflare tunnel" \
      "RemoteIPHeader CF-Connecting-IP" "RemoteIPInternalProxy 127.0.0.1 ::1" \
      | write_if_changed /etc/apache2/conf-available/onyoursite-tunnel.conf \
      || [ ! -e /etc/apache2/conf-enabled/onyoursite-tunnel.conf ]; then
    a2enmod -q remoteip >/dev/null
    a2enconf -q onyoursite-tunnel >/dev/null
    systemctl reload apache2
  fi
  # Anfragen dieses Servers an die eigene Domain (z. B. vom Discord-Bot) gehen direkt an Apache, nicht über Cloudflare
  sed -i '/# onyoursite-tunnel$/d' /etc/hosts
  echo "127.0.0.1 $DOMAIN # onyoursite-tunnel" >> /etc/hosts
}

# Antwortet die Website auf diesem Server? Dorthin schickt der Tunnel die Besucher. Geprüft wird die Startseite –
# dafür müssen Apache, Node.js und die Datenbank laufen.
origin_ok() {
  [ "$(curl -sk --noproxy '*' --max-time 90 --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -w '%{http_code}' \
    "https://$DOMAIN/" 2>/dev/null || true)" = 200 ]
}

# Von außen prüfen: eine zufällige Subdomain (die /etc/hosts nicht kennt) geht über Cloudflare und den Tunnel zu Apache.
# Abgefragt wird eine Datei mit Zufallsinhalt, die nur dieser Server hat – und nur eine Antwort über Cloudflare (cf-ray)
# zählt. So besteht weder der alte Server noch ein direkter Weg ohne Cloudflare die Prüfung (z. B. solange sich das DNS
# noch umstellt).
tunnel_probe() {
  local name code="" i tmp hdr file ok=0 direct=0
  file="static/oys-check-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n').txt"
  name="check-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n').$DOMAIN"
  # Reste abgebrochener Läufe weg; die neue Prüfdatei verschwindet auch bei Strg+C oder einer getrennten Verbindung
  rm -f "$CODE"/static/oys-check-*.txt
  tmp=$(mktemp)
  hdr=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f ${CF_ERRFILE:+'$CF_ERRFILE'} '$tmp' '$hdr' '$CODE/$file'" EXIT
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n' > "$CODE/$file"
  chmod 644 "$CODE/$file"
  info "Checking from outside (https://$name) …"
  for i in $(seq 1 12); do
    code=$(curl -s --max-time 15 -D "$hdr" -o "$tmp" -w '%{http_code}' "https://$name/$file" 2>/dev/null || true)
    direct=0
    if [ "$code" = 200 ] && cmp -s "$tmp" "$CODE/$file"; then
      if grep -qi '^cf-ray:' "$hdr"; then
        ok=1
        break
      fi
      direct=1
    fi
    sleep 5
  done
  rm -f "$tmp" "$hdr" "$CODE/$file"
  if [ -n "$CF_ERRFILE" ]; then
    # shellcheck disable=SC2064
    trap "rm -f '$CF_ERRFILE'" EXIT
  else
    trap - EXIT
  fi
  if [ "$ok" = 1 ]; then
    info "Visitors reach this server through Cloudflare and the tunnel – on $DOMAIN and every subdomain."
  elif [ "$direct" = 1 ]; then
    warn "$name reaches this server, but not through Cloudflare yet – the DNS may still be switching."
    warn "Check again in a few minutes: ${SUDO_HINT}bash $CODE/server/install.sh --tunnel"
  elif [[ $code =~ ^30[1278]$ ]]; then
    warn "Cloudflare sends https visitors to http – in Cloudflare, set SSL/TLS → Overview to Full (strict)."
  else
    warn "Through Cloudflare, $name didn’t answer with this server’s test file (last answer: ${code:-nothing})."
    warn "Log: journalctl -u onyoursite-tunnel – try again later: ${SUDO_HINT}bash $CODE/server/install.sh --tunnel"
  fi
}

# Welchen Tunnel betreibt ein Dienst „cloudflared“ auf diesem Server (z. B. aus Cloudflares Anleitung
# „cloudflared service install“)? Leer, wenn es keinen gibt.
other_connector() {
  local unit=/etc/systemd/system/cloudflared.service tok="" id="" f
  [ -f "$unit" ] || return 0
  if [ -s /etc/cloudflared/token ]; then tok=$(tr -d '[:space:]' < /etc/cloudflared/token); fi
  if [ -z "$tok" ]; then tok=$(grep -oE -- '--token[= ]+[A-Za-z0-9+/=_-]+' "$unit" | head -n 1 | sed -E 's/^--token[= ]+//' || true); fi
  if [ -n "$tok" ]; then
    # Das Token ist Base64 von {"a": Konto, "t": Tunnel, "s": Geheimnis}
    tok=$(printf '%s' "$tok" | tr '_-' '/+')
    while [ $(( ${#tok} % 4 )) -ne 0 ]; do tok="$tok="; done
    id=$(printf '%s' "$tok" | base64 -d 2>/dev/null | jq -r '.t // empty' 2>/dev/null || true)
  fi
  if [ -z "$id" ]; then
    for f in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml; do
      if [ -f "$f" ]; then id=$(sed -n 's/^tunnel:[[:space:]]*//p' "$f" | tr -d "\"' \r" | head -n 1); break; fi
    done
  fi
  printf '%s' "$id"
}

step_tunnel() {
  local force=${1:-} def guess tunnels t tid="" tname tok="" hosts mine allrecs repl dead posts m mx_warn="" st="" i r
  local ours_prefix del_ids=() del_names=() keep_names=() idle_names=() line changes=0 restart=0 alive dels v4 v6 direct
  local connector old_connector=0 problem="" cfg tsrc next orig
  bold "5/9  Cloudflare tunnel"
  if [ "$TUNNEL" = no ] && [ -z "$force" ]; then
    info "Not used – visitors reach this server directly. Later: ${SUDO_HINT}bash $CODE/server/install.sh --tunnel"
    return 0
  fi
  if [ "$TUNNEL" != yes ]; then
    info "With a Cloudflare Tunnel, visitors come in through Cloudflare: this server needs no open web ports,"
    info "its address stays hidden and Cloudflare filters attacks. The DNS of $DOMAIN has to be at Cloudflare."
    def=n
    guess=$(dns_guess)
    if [ "$guess" = 1 ]; then def=y; info "The DNS of $DOMAIN is at Cloudflare."; fi
    case "$(choose "Connect $DOMAIN through a Cloudflare Tunnel? [$([ "$def" = y ] && echo Y/n || echo y/N)]" "$def")" in
      [yY]*) ;;
      *) TUNNEL=no; info "No tunnel – visitors reach this server directly. Later: ${SUDO_HINT}bash $CODE/server/install.sh --tunnel"; return 0 ;;
    esac
  fi
  apt_install jq curl
  if [ -z "$CF_ERRFILE" ]; then
    CF_ERRFILE=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '$CF_ERRFILE'" EXIT
  fi
  if ! cf_login; then
    warn "Without a Cloudflare token there is no tunnel – nothing was changed."
    if [ "$TUNNEL" != yes ]; then TUNNEL=no; fi
    return 0
  fi
  if [ "$ZONE_STATUS" != active ]; then
    warn "$DOMAIN isn’t active at Cloudflare yet (status: $ZONE_STATUS) – switch its nameservers to Cloudflare first."
    if [ "$TUNNEL" != yes ]; then TUNNEL=no; fi
    return 0
  fi

  # Unser Tunnel (gespeichert und noch vorhanden) wird weiterverwendet
  tunnels=$(cf GET "/accounts/$ACC_ID/cfd_tunnel?is_deleted=false&per_page=1000") || cf_fail "Cloudflare"
  if [ -n "$TUNNEL_ID" ] && jq -e --arg id "$TUNNEL_ID" 'any(.[]; .id == $id)' <<< "$tunnels" >/dev/null; then
    tid=$TUNNEL_ID
  fi
  # Alte Tunnel: nur solche, die ausschließlich diese Website bedienen – oder Reste dieses Servers ohne Regeln.
  # Tunnel, die auch andere Namen bedienen (z. B. nas.$DOMAIN), bleiben – der Installer weist nur darauf hin.
  mine=$(jq -nc --arg d "$DOMAIN" '[$d, "www." + $d, "*." + $d]')
  ours_prefix="onyoursite-$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
  while IFS=$'\t' read -r t tname tsrc; do
    if [ -z "$t" ] || [ "$t" = "$tid" ]; then continue; fi
    # Sind die Regeln nicht lesbar, entscheidet der Installer nichts – lieber bleibt ein Rest als ein fremder Tunnel geht
    cfg=$(cf GET "/accounts/$ACC_ID/cfd_tunnel/$t/configurations") || continue
    hosts=$(jq -c '[.config.ingress[]?.hostname // empty]' <<< "$cfg" 2>/dev/null || echo '[]')
    if jq -e --argjson m "$mine" 'length > 0 and all(.[]; . as $h | $m | index($h))' <<< "$hosts" >/dev/null; then
      del_ids+=("$t"); del_names+=("$tname")
    elif [ "$tsrc" = cloudflare ] && [ "$(jq 'length' <<< "$hosts")" = 0 ] \
      && { [ "$tname" = "$ours_prefix" ] || [[ $tname == "$ours_prefix"-* ]]; }; then
      # Ein über Cloudflare verwalteter Tunnel ohne Regeln bedient nichts (Rest eines abgebrochenen Laufs)
      del_ids+=("$t"); del_names+=("$tname")
    elif jq -e --argjson m "$mine" 'any(.[]; . as $h | $m | index($h))' <<< "$hosts" >/dev/null; then
      keep_names+=("$tname")
    fi
  done < <(jq -r '.[] | [.id, .name, (.config_src // (if .remote_config then "cloudflare" else "local" end))] | @tsv' <<< "$tunnels")

  # Alle DNS-Einträge der Zone auf einmal – dann sieht der Installer auch den Platzhalter * zuverlässig
  allrecs=$(cf GET "/zones/$ZONE_ID/dns_records?per_page=5000") || cf_fail "Cloudflare DNS"
  # Im Weg: A, AAAA und CNAME von @, www und * – außer sie zeigen schon auf diesen Tunnel und laufen über Cloudflare
  # (ein CNAME auf einen Tunnel ohne Cloudflare-Proxy funktioniert nicht)
  repl=$(jq -c --argjson m "$mine" --arg c "${tid:-none}.cfargotunnel.com" \
    '[.[] | select((.type == "A" or .type == "AAAA" or .type == "CNAME") and (.name as $n | $m | index($n))
       and (.type != "CNAME" or .content != $c or .proxied != true))]' <<< "$allrecs")
  # Tot: CNAMEs auf Tunnel, die es nicht mehr gibt oder die gleich gelöscht werden
  alive=$(jq -c --argjson del "$(printf '%s\n' "${del_ids[@]}" | jq -R . | jq -sc 'map(select(length > 0))')" '[.[] | .id] - $del' <<< "$tunnels")
  if [ -n "$tid" ]; then alive=$(jq -c --arg id "$tid" '. + [$id] | unique' <<< "$alive"); fi
  dead=$(jq -c --argjson m "$mine" --argjson alive "$alive" \
    '[.[] | select(.type == "CNAME" and (.content | test("\\.cfargotunnel\\.com\\.?$")) and ((.name as $n | $m | index($n)) | not)
       and ((.content | sub("\\.cfargotunnel\\.com\\.?$"; "")) as $u | $alive | index($u) | not))]' <<< "$allrecs")
  # Tunnel, auf die die alten Einträge zeigen, deren Regeln der Installer aber nicht sieht (auf ihrem Server verwaltet):
  # sie bekommen keine Besucher von $DOMAIN mehr, werden aber nicht gelöscht – sie könnten noch anderes bedienen
  while IFS=$'\t' read -r t tname; do
    if [ -n "$t" ] && [ "$t" != "$tid" ] && ! in_list "$t" "${del_ids[@]}" && ! in_list "$tname" "${keep_names[@]}" \
      && jq -e --arg u "$t" 'any(.[]; .type == "CNAME" and (.content | sub("\\.cfargotunnel\\.com\\.?$"; "")) == $u)' <<< "$repl" >/dev/null; then
      idle_names+=("$tname")
    fi
  done < <(jq -r '.[] | [.id, .name] | @tsv' <<< "$tunnels")
  # Mail: zeigt ein MX-Eintrag – direkt oder über CNAMEs – auf einen Namen, der gleich auf Cloudflare zeigt
  # (@, www oder einen Namen ohne eigenen Eintrag, für den der Platzhalter * gilt), käme keine Mail mehr an
  while IFS= read -r m; do
    m=${m%.}
    orig=$m
    for i in 1 2 3 4 5; do
      # Ein Name außerhalb dieser Domain bleibt, wie er ist
      if [ -z "$m" ] || { [ "$m" != "$DOMAIN" ] && [[ $m != *".$DOMAIN" ]]; }; then break; fi
      if [ "$m" = "$DOMAIN" ] || [ "$m" = "www.$DOMAIN" ]; then mx_warn=$orig; break; fi
      if jq -e --arg n "$m" 'any(.[]; .name == $n and (.type == "A" or .type == "AAAA"))' <<< "$allrecs" >/dev/null; then break; fi
      next=$(jq -r --arg n "$m" '[.[] | select(.name == $n and .type == "CNAME") | .content][0] // empty' <<< "$allrecs")
      if [ -z "$next" ]; then mx_warn=$orig; break; fi
      m=${next%.}
    done
  done < <(jq -r '.[] | select(.type == "MX") | .content' <<< "$allrecs")
  # Einträge, die ohne Cloudflare direkt auf diesen Server zeigen, verraten seine Adresse (sie werden nicht angefasst)
  v4=$(ip4)
  v6=$(ip6)
  direct=$(jq -r --argjson m "$mine" --arg a "${v4:-none}" --arg b "${v6:-none}" \
    '[.[] | select((.type == "A" or .type == "AAAA") and (.content == $a or .content == $b) and (.proxied | not)
       and ((.name as $n | $m | index($n)) | not)) | .name] | join(", ")' <<< "$allrecs")

  echo
  info "Plan for $DOMAIN:"
  if [ -z "$tid" ]; then info "  + a new tunnel for this server"; changes=1; fi
  while IFS= read -r line; do
    if [ -n "$line" ]; then info "  - delete DNS  $line"; changes=1; fi
  done < <(jq -r '.[] | "\(.type)  \(.name)  \(.content)"' <<< "$repl$dead")
  if [ "$(jq -r --arg c "${tid:-none}.cfargotunnel.com" --argjson m "$mine" '[.[] | select(.type == "CNAME" and .content == $c and .proxied == true and (.name as $n | $m | index($n)))] | length' <<< "$allrecs")" != 3 ]; then
    info "  + DNS  $DOMAIN, www.$DOMAIN and *.$DOMAIN → the tunnel (through Cloudflare)"
    changes=1
  fi
  for i in "${!del_ids[@]}"; do
    info "  - delete the old tunnel ${del_names[$i]} (${del_ids[$i]})"
    changes=1
  done
  # Läuft auf diesem Server noch der Dienst eines alten Tunnels, der gleich gelöscht wird, kommt er mit weg
  connector=$(other_connector)
  if [ -n "$connector" ] && in_list "$connector" "${del_ids[@]}"; then
    info "  - remove the service cloudflared on this server (it runs the old tunnel)"
    old_connector=1
    changes=1
  fi
  if [ "$changes" = 0 ]; then
    info "  Everything is in place."
  else
    info "  Mail records (MX, TXT), all other names and other tunnels stay as they are."
  fi
  if [ "${#keep_names[@]}" -gt 0 ]; then
    warn "These tunnels also serve other names and stay: ${keep_names[*]} – remove $DOMAIN from their rules by hand if needed."
  fi
  if [ "${#idle_names[@]}" -gt 0 ]; then
    warn "These tunnels won’t get visitors for $DOMAIN any more but stay (they may serve other things): ${idle_names[*]}"
    warn "Delete them in Cloudflare (Zero Trust → Networks → Tunnels) if nothing else uses them."
  fi
  if [ -n "$direct" ]; then
    warn "These records point straight to this server and reveal its address: $direct"
  fi
  if [ "$changes" = 1 ]; then
    if [ -n "$mx_warn" ]; then
      warn "Mail for $DOMAIN goes to $mx_warn – that name would then point to Cloudflare and mail would stop."
      warn "Give the mail server its own name with its own A record first (e.g. mail.$DOMAIN)."
    fi
    warn "From then on, every visitor of $DOMAIN reaches this server."
    case "$(choose "Do it now? [y/N]" n)" in
      [yY]*) ;;
      *) info "Nothing was changed. Later: ${SUDO_HINT}bash $CODE/server/install.sh --tunnel"; if [ "$TUNNEL" != yes ]; then TUNNEL=no; fi; return 0 ;;
    esac
  fi

  # 1. Tunnel anlegen – mit eigenem Namen, damit alte Tunnel bis zum Umschalten weiterlaufen. Die ID wird sofort
  #    gespeichert: bricht danach etwas ab, nimmt der nächste Lauf diesen Tunnel wieder, statt ihn als alt zu löschen.
  if [ -z "$tid" ]; then
    tname=$ours_prefix
    i=2
    while jq -e --arg n "$tname" 'any(.[]; .name == $n)' <<< "$tunnels" >/dev/null; do
      tname="$ours_prefix-$i"
      i=$((i + 1))
    done
    t=$(cf POST "/accounts/$ACC_ID/cfd_tunnel" "$(jq -nc --arg n "$tname" '{name: $n, config_src: "cloudflare"}')") \
      || cf_fail "The tunnel couldn’t be created"
    tid=$(jq -r '.id' <<< "$t")
    tok=$(jq -r '.token // empty' <<< "$t")
    TUNNEL_ID=$tid
    conf_set TUNNEL_ID "$tid"
    info "Tunnel $tname created."
  fi
  if [ -z "$tok" ]; then
    tok=$(cf GET "/accounts/$ACC_ID/cfd_tunnel/$tid/token" | jq -r '.') || cf_fail "The tunnel token couldn’t be read"
  fi
  install -d -m 700 "$CONF_DIR"
  if printf 'TUNNEL_TOKEN=%s\n' "$tok" | write_if_changed "$TUNNEL_ENV" 600; then restart=1; fi
  TUNNEL_ID=$tid

  # 2. Regeln: alle drei Namen gehen an Apache auf diesem Server – mit der Domain als SNI, damit der richtige vhost antwortet
  cf PUT "/accounts/$ACC_ID/cfd_tunnel/$tid/configurations" "$(jq -nc --arg d "$DOMAIN" '{config: {ingress:
      (([$d, "www." + $d, "*." + $d] | map({hostname: ., service: "https://127.0.0.1:443",
        originRequest: {originServerName: $d, noTLSVerify: true}})) + [{service: "http_status:404"}])}}')" >/dev/null \
    || cf_fail "The tunnel rules couldn’t be saved"

  # 3. cloudflared starten und warten, bis Cloudflare den Tunnel als verbunden meldet
  tunnel_local "$restart"
  info "Waiting for the tunnel to connect …"
  for i in $(seq 1 30); do
    st=$(cf GET "/accounts/$ACC_ID/cfd_tunnel/$tid" | jq -r '.status' 2>/dev/null || true)
    if [ "$st" = healthy ]; then break; fi
    sleep 2
  done
  # Was am DNS zu ändern ist: alte Einträge weg, CNAMEs auf den Tunnel
  dels=$(jq -c -s 'add | map({id})' <<< "$repl$dead")
  posts=$(jq -c --argjson m "$mine" --arg c "$tid.cfargotunnel.com" \
    '[$m[] as $n | select(([.[] | select(.name == $n and .type == "CNAME" and .content == $c and .proxied == true)] | length) == 0)
      | {type: "CNAME", name: $n, content: $c, proxied: true, ttl: 1, comment: "OnYourSite tunnel"}]' <<< "$allrecs")
  # „degraded“: verbunden, nur noch nicht über alle vier Leitungen – reicht für Besucher
  if [ "$st" != healthy ] && [ "$st" != degraded ]; then
    problem="Cloudflare doesn’t report the tunnel as connected yet (status: ${st:-unknown}). Log: journalctl -u onyoursite-tunnel"
  elif ! origin_ok; then
    problem="The website doesn’t answer on this server (https://$DOMAIN on 127.0.0.1) – visitors would get an error. Log: /var/log/apache2/onyoursite-error.log"
  fi
  if [ -n "$problem" ]; then
    warn "$problem"
    # Zeigt das DNS schon auf den Tunnel, gibt es nichts mehr zu entscheiden – nur der Hinweis
    if [ "$dels" != "[]" ] || [ "$posts" != "[]" ]; then
      case "$(choose "Switch the DNS anyway? [y/N]" n)" in
        [yY]*) ;;
        *)
          # Der Tunnel bleibt angelegt (der nächste Lauf nimmt ihn wieder), die Seite läuft wie bisher weiter
          info "The DNS stays as it is and the web ports stay open. Try again: ${SUDO_HINT}bash $CODE/server/install.sh --tunnel"
          if [ "$TUNNEL" != yes ]; then TUNNEL=no; fi
          return 0 ;;
      esac
    fi
  fi

  # 4. DNS umstellen – in einem Schritt (alles oder nichts)
  if [ "$dels" != "[]" ] || [ "$posts" != "[]" ]; then
    if ! cf POST "/zones/$ZONE_ID/dns_records/batch" "$(jq -nc --argjson d "$dels" --argjson p "$posts" '{deletes: $d, posts: $p}')" >/dev/null; then
      # Ein Fehler in der Sammel-Änderung ändert nichts – nur wenn es sie gar nicht gibt, geht es einzeln weiter
      if ! grep -qiE 'no route|\((7000|7003)\)' <<< "$(cf_err)"; then cf_fail "The DNS couldn’t be switched (nothing was changed)"; fi
      # Einzeln: erst löschen, dann anlegen – ein CNAME darf nicht neben A/AAAA stehen
      while IFS= read -r r; do
        cf DELETE "/zones/$ZONE_ID/dns_records/$r" >/dev/null || cf_fail "A DNS record couldn’t be deleted"
      done < <(jq -r '.[].id' <<< "$dels")
      while IFS= read -r r; do
        cf POST "/zones/$ZONE_ID/dns_records" "$r" >/dev/null || cf_fail "A DNS record couldn’t be created"
      done < <(jq -c '.[]' <<< "$posts")
    fi
  fi
  TUNNEL=yes
  conf_set TUNNEL yes

  # 5. Alte Tunnel dieser Website löschen (erst ihre Verbindungen trennen; zur Not samt allem, was daran hängt).
  #    Ein Dienst auf diesem Server, der einen davon betreibt, wird vorher entfernt (wie „cloudflared service uninstall“).
  if [ "$old_connector" = 1 ]; then
    systemctl disable --now cloudflared.service >/dev/null 2>&1 || true
    systemctl disable --now cloudflared-update.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/cloudflared.service /etc/systemd/system/cloudflared-update.service \
      /etc/systemd/system/cloudflared-update.timer /etc/cloudflared/token
    # Seine Einstellungen würde cloudflared sonst auch für den neuen Tunnel lesen
    for i in /etc/cloudflared/config.yml /etc/cloudflared/config.yaml; do
      if [ -f "$i" ]; then mv -f "$i" "$i.old"; fi
    done
    systemctl daemon-reload
    info "Removed the old cloudflared service of this server."
  fi
  for i in "${!del_ids[@]}"; do
    cf DELETE "/accounts/$ACC_ID/cfd_tunnel/${del_ids[$i]}/connections" >/dev/null || true
    if cf DELETE "/accounts/$ACC_ID/cfd_tunnel/${del_ids[$i]}" >/dev/null \
      || cf DELETE "/accounts/$ACC_ID/cfd_tunnel/${del_ids[$i]}?cascade=true" >/dev/null; then
      info "Deleted the old tunnel ${del_names[$i]}."
    else
      warn "The old tunnel ${del_names[$i]} couldn’t be deleted ($(cf_err)) – it may still run somewhere; delete it in Cloudflare."
    fi
  done
  info "$DOMAIN, www.$DOMAIN and every subdomain now come through the tunnel – no web ports have to be open."
  # Von außen geprüft wird erst, wenn die Firewall die Web-Ports geschlossen hat: dann kann nur noch der Tunnel antworten,
  # nicht mehr ein alter Weg von Cloudflare direkt zu diesem Server
  PROBE_TUNNEL=1
}

# ---------------------------------------------------------------
write_timers() {
  local tz
  tz=$(cfg_get timezone)
  if [ -z "$tz" ] || [ ! -f "/usr/share/zoneinfo/$tz" ]; then tz=""; fi
  # Wochenbericht mit dem Befehl der Webseite (ohne Node.js bleibt die vorhandene Unit, wie sie ist)
  if [ -n "$NODE" ]; then
    cat > "$UNITS/onyoursite-weekly-report.service" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite weekly report emails
After=mariadb.service

[Service]
Type=oneshot
User=$WEB
Group=$WEB
WorkingDirectory=$CODE/app
Environment=NODE_ENV=production
ExecStart=$NODE $CODE/app/dist/cli.js weekly-report
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
EOF
  fi
  cat > "$UNITS/onyoursite-weekly-report.timer" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite weekly report, Mondays at 8:00

[Timer]
OnCalendar=Mon *-*-* 08:00:00${tz:+ $tz}
Persistent=true

[Install]
WantedBy=timers.target
EOF
  cat > "$UNITS/onyoursite-backup.service" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite backup (database, uploads, settings)
After=mariadb.service

[Service]
Type=oneshot
ExecStart=/bin/bash $CODE/server/backup.sh
Nice=10
IOSchedulingClass=idle
EOF
  cat > "$UNITS/onyoursite-backup.timer" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite backup every night

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF
  if [ -x "$ACME" ]; then
    cat > "$UNITS/onyoursite-certs.service" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=Renew the OnYourSite certificate when it is due

[Service]
Type=oneshot
# Renews about 30 days before the end and reloads Apache – then warns the admins by email if it gets close
ExecStart=-$ACME --cron --home $ACME_HOME
ExecStart=/bin/bash $CODE/server/cert-check.sh
EOF
    cat > "$UNITS/onyoursite-certs.timer" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=Check the OnYourSite certificate every day

[Timer]
OnCalendar=*-*-* 04:40:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF
  fi
  systemctl daemon-reload
  systemctl enable --now onyoursite-weekly-report.timer onyoursite-backup.timer >/dev/null 2>&1
  if [ -x "$ACME" ]; then systemctl enable --now onyoursite-certs.timer >/dev/null 2>&1; fi
}

# write_if_changed DATEI [RECHTE] – nur schreiben, wenn sich der Inhalt ändert (Inhalt über stdin); 0 = geändert
write_if_changed() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then
    rm -f "$tmp"
    return 1
  fi
  install -m "${2:-644}" "$tmp" "$1"
  rm -f "$tmp"
}

step_protect() {
  local ssh_cfg ssh_sock ssh_live ssh_now ports list p
  apt_install ufw fail2ban python3-systemd unattended-upgrades
  # Firewall: nur SSH, HTTP und HTTPS. Der SSH-Port wird nie ausgesperrt – auch wenn er nicht 22 ist
  # sshd -T braucht den Ordner, den sonst erst der laufende SSH-Dienst anlegt (z. B. Socket-Aktivierung bei Ubuntu 24.04)
  if command -v sshd >/dev/null 2>&1; then install -d -m 755 /run/sshd; fi
  ssh_cfg=$( { sshd -T 2>/dev/null || true; } | awk '$1 == "port" {print $2}')
  ssh_sock=$( { systemctl show -p Listen --value ssh.socket 2>/dev/null || true; } | sed -n 's/.*:\([0-9][0-9]*\) .*/\1/p')
  # Weiterleitungen von sshd lauschen nur auf localhost – die zählen nicht
  ssh_live=$( { ss -Htlnp 2>/dev/null || true; } | awk '/"sshd/ && $4 !~ /^(127\.|\[::1\]|::1)/ {n = split($4, a, ":"); print a[n]}')
  ssh_now=$( { ss -Htnp state established 2>/dev/null || true; } | awk '/"sshd/ && $3 !~ /^(127\.|\[::1\]|::1)/ {n = split($3, a, ":"); print a[n]}')
  ports=$(printf '%s\n%s\n%s\n%s\n' "$ssh_cfg" "$ssh_sock" "$ssh_live" "$ssh_now" | grep -E '^[0-9]+$' | sort -un | paste -sd, - || true)
  [ -n "$ports" ] || ports=22
  IFS=, read -ra list <<< "$ports"
  for p in "${list[@]}"; do ufw allow "$p/tcp" comment SSH >/dev/null; done
  if [ "$TUNNEL" = yes ]; then
    # Besucher kommen nur über den Tunnel – die Web-Ports bleiben von außen zu
    ufw delete allow 80/tcp >/dev/null 2>&1 || true
    ufw delete allow 443/tcp >/dev/null 2>&1 || true
  else
    ufw allow 80/tcp comment HTTP >/dev/null
    ufw allow 443/tcp comment HTTPS >/dev/null
  fi
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  # fail2ban: 5 falsche SSH-Anmeldungen in 10 Minuten – eine Stunde gesperrt
  printf '%s\n' "# OnYourSite – written by server/install.sh" "[sshd]" "enabled = true" "backend = systemd" \
    "maxretry = 5" "findtime = 10m" "bantime = 1h" > /etc/fail2ban/jail.d/onyoursite.conf
  systemctl enable fail2ban >/dev/null 2>&1
  systemctl restart fail2ban
  # Sicherheitsupdates installieren sich selbst
  printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
  # Datenbank nur von diesem Server aus erreichbar, keine Dateien über SQL einlesen
  if [ -d /etc/mysql/mariadb.conf.d ] && write_if_changed /etc/mysql/mariadb.conf.d/90-onyoursite.cnf <<'EOF'
# OnYourSite – written by server/install.sh
[mysqld]
bind-address = 127.0.0.1
local-infile = 0
EOF
  then
    systemctl restart mariadb
  fi
  # Netz: keine umgeleiteten Routen annehmen oder senden, SYN-Cookies gegen Überflutung
  if write_if_changed /etc/sysctl.d/90-onyoursite.conf <<'EOF'
# OnYourSite – written by server/install.sh
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
kernel.dmesg_restrict = 1
EOF
  then
    sysctl --system >/dev/null 2>&1 || true
  fi
  if [ "$TUNNEL" = yes ]; then
    info "Firewall: only SSH (port $ports) gets through – visitors come in through the Cloudflare tunnel."
  else
    info "Firewall: only SSH (port $ports), HTTP and HTTPS get through."
  fi
  info "fail2ban: 5 wrong SSH logins in 10 minutes = blocked for an hour. Security updates install by themselves."
  info "The database only answers this server, the website runs as its own locked-down service, network settings are hardened."
}

# SSH nur mit Schlüssel – nur wenn es hier schon einen Schlüssel gibt, und nur auf Nachfrage
step_ssh() {
  local f home="" keys=0 conf=/etc/ssh/sshd_config.d/00-onyoursite.conf
  [ "$MODE" = install ] || return 0
  # Schon entschieden? „nokey“ heißt: damals gab es keinen Schlüssel – dann jetzt noch einmal prüfen
  if [ -n "$SSH_KEYONLY" ] && [ "$SSH_KEYONLY" != nokey ]; then return 0; fi
  command -v sshd >/dev/null 2>&1 || return 0
  grep -qsE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config || return 0
  if [ -n "${SUDO_USER:-}" ]; then home=$(getent passwd "$SUDO_USER" | cut -d: -f6); fi
  for f in /root/.ssh/authorized_keys ${home:+"$home/.ssh/authorized_keys"}; do
    if [ -f "$f" ] && grep -qE '^(ssh-|ecdsa-|sk-)' "$f"; then keys=1; fi
  done
  if [ "$keys" = 0 ]; then
    info "SSH: logins with a password stay allowed (there is no SSH key on this server)."
    SSH_KEYONLY=nokey
    return 0
  fi
  echo
  info "SSH logins only with a key make password guessing useless. Only say yes if you log in"
  info "with an SSH key – with a password you would lock yourself out."
  case "$(choose "Allow SSH logins only with a key? [y/N]" n)" in
    [yY]*) ;;
    *) SSH_KEYONLY=no; return 0 ;;
  esac
  # Nur Passwörter abschalten – PermitRootLogin bleibt, wie der Admin es eingestellt hat
  printf '%s\n' "# OnYourSite – written by server/install.sh" "PasswordAuthentication no" "KbdInteractiveAuthentication no" > "$conf"
  # Die Prüfung braucht den Ordner, den sonst der laufende SSH-Dienst anlegt
  install -d -m 755 /run/sshd
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    SSH_KEYONLY=yes
    info "SSH: only logins with a key from now on (undo: rm $conf && systemctl reload ssh)."
  else
    rm -f "$conf"
    warn "The SSH settings didn’t pass the check – nothing was changed."
    SSH_KEYONLY=no
  fi
}

step_services() {
  bold "7/9  Protection, backups and weekly report"
  step_protect
  step_ssh
  write_timers
  info "Weekly report: Mondays at 8:00 · Backup: every night to $BACKUPS (kept $BACKUP_DAYS days)"
}

# Das erste Admin-Konto (nur bei einer neuen Installation ohne Admin)
step_admin() {
  local admins name email slug pw pw2 out
  admins=$(mariadb -N "$DB_NAME" -e "SELECT COUNT(*) FROM users WHERE is_admin = 1" 2>/dev/null || echo 0)
  [ "$admins" = 0 ] || return 0
  bold "8/9  Admin account"
  case "$(choose "There is no admin account yet. Create yours now? [Y/n]" y)" in
    [nN]*)
      info "Later: register on the website, then make your account an admin:"
      info "  ${SUDO_HINT}mariadb $DB_NAME -e \"UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'\""
      return 0 ;;
  esac
  while true; do
    prompt name "Your name:"
    prompt email "Email address (for logging in):"
    prompt slug "Address of your page (name for name.$DOMAIN):"
    while true; do
      prompt pw "Password (at least 8 characters):" hidden
      prompt pw2 "The password again:" hidden
      if [ "$pw" != "$pw2" ]; then info "  The passwords aren’t the same."; continue; fi
      if [ "${#pw}" -lt 8 ]; then info "  At least 8 characters, please."; continue; fi
      break
    done
    # Die Angaben gehen über die Umgebung an die Webseite, nicht über die Befehlszeile
    if out=$(OYS_NAME=$name OYS_EMAIL=$email OYS_SLUG=$slug OYS_PASSWORD=$pw runuser -u "$WEB" -- "$NODE" "$CODE/app/dist/cli.js" create-admin 2>&1); then
      info "$out"
      return 0
    fi
    info "  $out"
  done
}

# ---------------------------------------------------------------
step_bot() {
  local secret
  bold "9/9  Discord bot"
  # Als Systemdienst – oder in Docker im Code-Ordner (dieselbe Prüfung wie discord-bot/install.sh)
  if [ -f "$UNITS/onyoursite-bot.service" ] || { [ -s "$CODE/discord-bot/.env" ] && [ -f "$CODE/discord-bot/docker-compose.yml" ]; }; then
    bash "$CODE/discord-bot/install.sh" --update || warn "The bot update didn’t finish – see above."
    return 0
  fi
  if [ "$MODE" != install ]; then info "Not set up on this server."; return 0; fi
  if cert_temporary; then
    info "The bot can be set up once the real HTTPS certificate is there (${SUDO_HINT}bash $CODE/server/install.sh --https)."
    info "Then run ${SUDO_HINT}bash $CODE/server/install.sh again and answer y here."
    return 0
  fi
  case "$(choose "Set up the Discord bot on this server too? [y/N]" n)" in
    [yY]*) ;;
    *) info "Skipped – run ${SUDO_HINT}bash $CODE/server/install.sh again any time and answer y here."; return 0 ;;
  esac
  if ! points_here; then
    warn "As far as this server can tell, $DOMAIN doesn’t point here yet – and the bot reaches the website through it."
    case "$(choose "Set it up anyway (e.g. the DNS is switched, but the server is behind a cloud NAT)? [y/N]" n)" in
      [yY]*) ;;
      *) info "Run ${SUDO_HINT}bash $CODE/server/install.sh again once the DNS points here and answer y."; return 0 ;;
    esac
  fi
  secret=$(cfg_get bot_secret)
  if [ "${#secret}" -lt 32 ]; then
    secret=$(openssl rand -hex 32)
    OYS_VALUE=$secret "$NODE" "$CONFIG_MJS" set bot_secret --file "$CODE/config.json" || fail "config.json couldn’t be changed – see above."
    # Die Webseite liest ihre Einstellungen beim Start
    systemctl restart onyoursite-web
    PORT=$(web_port)
    wait_web || warn "The website didn’t answer after the restart – see: journalctl -u onyoursite-web"
    info "A new bot_secret is in config.json."
  fi
  OYS_SITE_URL="https://$DOMAIN" OYS_BOT_SECRET=$secret bash "$CODE/discord-bot/install.sh" --service \
    || warn "The bot isn’t running yet – see above. Its installer can run again any time: ${SUDO_HINT}bash $CODE/discord-bot/install.sh"
}

check_site() {
  local code
  if [ -f "$WEB_UNIT" ] && ! systemctl is-active --quiet onyoursite-web; then
    warn "The website service onyoursite-web isn’t running – the last lines of its log:"
    web_log 30
    return 0
  fi
  code=$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 90 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)
  if [ "$code" = 200 ]; then
    info "The website answers on this server."
  else
    warn "The website answered with ${code:-nothing} – the last lines of its log (journalctl -u onyoursite-web):"
    web_log 20
    tail -n 5 /var/log/apache2/onyoursite-error.log 2>/dev/null | sed 's/^/    /' || true
  fi
}

summary() {
  local v4 v6
  bold "Checking the website"
  check_site
  v4=$(ip4)
  v6=$(ip6)
  bold "Done."
  info "Website: https://$DOMAIN · code: $CODE · uploads: $UPLOADS"
  if [ "$TUNNEL" = yes ]; then
    info "Visitors come in through the Cloudflare tunnel – this server has no open web ports."
  fi
  if ! points_here; then
    echo
    info "If the DNS of $DOMAIN doesn’t point to this server yet, change it at your DNS provider:"
    info "  A     @, www and *   ${v4:-<public IPv4 of this server>}"
    if [ -n "$v6" ]; then info "  AAAA  @, www and *   $v6"; fi
    info "Test it before switching – add this line to the hosts file of your computer:"
    info "  ${v4:-<IPv4>}  $DOMAIN www.$DOMAIN yourname.$DOMAIN"
  fi
  if cert_temporary && [ "$TUNNEL" = yes ]; then
    info "Visitors see Cloudflare’s certificate. A real certificate on this server is only needed for the Discord bot:"
    info "  ${SUDO_HINT}bash $CODE/server/install.sh --https"
  elif cert_temporary; then
    warn "HTTPS still uses a temporary certificate. Set up the real one: ${SUDO_HINT}bash $CODE/server/install.sh --https"
  fi
  echo
  info "Update:   ${SUDO_HINT}bash $CODE/server/install.sh --update"
  info "Backups:  $BACKUPS – every night, kept $BACKUP_DAYS days. Copy them off the server now and then."
  info "Errors:   journalctl -u onyoursite-web -f"
  if [ -n "${IMPORT:-}" ]; then
    warn "$IMPORT holds passwords and all data from the old server – delete it once everything works here:"
    info "  rm -rf $IMPORT"
  fi
}

# ---------------------------------------------------------------
# Läuft das Skript allein (nicht im Code-Ordner), holt es zuerst den Code von GitHub nach /var/www/onyoursite.
# GitHubs Hostschlüssel: aus der API (per HTTPS geprüft), sonst per ssh-keyscan mit dem veröffentlichten Fingerabdruck
github_host_keys() {
  local keys
  keys=$(curl -fsSL --max-time 20 https://api.github.com/meta 2>/dev/null \
    | grep -oE '"(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+"' | tr -d '"' || true)
  if [ -z "$keys" ]; then
    keys=$(ssh-keyscan -t ed25519 github.com 2>/dev/null | grep -v '^#' | cut -d' ' -f2- || true)
    [ -n "$keys" ] || return 1
    [ "$(printf 'github.com %s\n' "$keys" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')" = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU" ] || return 1
  fi
  printf '%s\n' "$keys" | sed 's/^/github.com /' > "$GITHUB_HOSTS"
}

get_code() {
  local url ssh_cmd asked=0 current
  bold "Getting OnYourSite"
  # shellcheck source=/dev/null
  case "$(. /etc/os-release && echo "${ID:-}")" in
    ubuntu|debian) ;;
    *) fail "This installer is made for Ubuntu (22.04 or newer) and Debian (12 or newer)." ;;
  esac
  if [ -f "$TARGET/server/install.sh" ] && { [ -f "$TARGET/app/package.json" ] || [ -f "$TARGET/index.php" ]; }; then
    info "The code is already in $TARGET."
    current=$(git -c safe.directory="$TARGET" -C "$TARGET" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [ "$BRANCH_GIVEN" = 1 ] && [ -n "$current" ] && [ "$current" != "$BRANCH" ]; then
      info "It is on the branch $current. To switch: ${SUDO_HINT}bash $TARGET/server/install.sh --update --branch $BRANCH"
    fi
    exec bash "$TARGET/server/install.sh" "$@"
  fi
  if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    fail "$TARGET already exists but holds no OnYourSite code – move it away and run this again."
  fi
  export DEBIAN_FRONTEND=noninteractive
  info "Installing git …"
  apt_update
  apt_install git openssh-client curl ca-certificates
  url=${OYS_REPO_URL:-https://github.com/$REPO.git}
  if GIT_TERMINAL_PROMPT=0 git ls-remote "$url" >/dev/null 2>&1; then
    git ls-remote --exit-code --heads "$url" "$BRANCH" >/dev/null 2>&1 || fail "There is no branch $BRANCH in $REPO."
    git clone -q --branch "$BRANCH" "$url" "$TARGET"
  else
    # Privates Repository: Lesezugriff mit einem Deploy-Key, der nur zu diesem Server gehört
    install -d -m 700 /root/.ssh
    if [ ! -f "$DEPLOY_KEY" ]; then ssh-keygen -q -t ed25519 -N "" -C "onyoursite@$(hostname)" -f "$DEPLOY_KEY"; fi
    github_host_keys || fail "GitHub can’t be reached from this server (api.github.com or github.com on port 22)."
    ssh_cmd="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$GITHUB_HOSTS -o StrictHostKeyChecking=yes"
    url=git@github.com:$REPO.git
    if ! GIT_SSH_COMMAND=$ssh_cmd git ls-remote "$url" >/dev/null 2>&1; then
      info "The repository $REPO is private. Give this server read access with a deploy key:"
      info "  1. Open https://github.com/$REPO/settings/keys/new"
      info "  2. Title: $(hostname) – Key: the line below – leave 'Allow write access' off – Add key"
      echo
      echo "  $(cat "$DEPLOY_KEY.pub")"
      echo
      while ! GIT_SSH_COMMAND=$ssh_cmd git ls-remote "$url" >/dev/null 2>&1; do
        if [ "$asked" = 1 ]; then info "  GitHub doesn’t accept the key yet – is it added to $REPO (Settings → Deploy keys)?"; fi
        read -rp "  Press Enter once the key is added … " _ || fail "The input ended – please run the installer in a terminal."
        asked=1
      done
    fi
    GIT_SSH_COMMAND=$ssh_cmd git ls-remote --exit-code --heads "$url" "$BRANCH" >/dev/null 2>&1 || fail "There is no branch $BRANCH in $REPO."
    GIT_SSH_COMMAND=$ssh_cmd git clone -q --branch "$BRANCH" "$url" "$TARGET"
    git -C "$TARGET" config core.sshCommand "$ssh_cmd"
  fi
  if [ ! -f "$TARGET/server/install.sh" ] || [ ! -f "$TARGET/app/package.json" ]; then
    rm -rf "$TARGET"
    fail "The branch $BRANCH doesn’t contain the installer (server/install.sh) – nothing was installed."
  fi
  info "The code is in $TARGET (branch $BRANCH)."
  exec bash "$TARGET/server/install.sh" "$@"
}

# ---------------------------------------------------------------
# Update. Die neue Version entsteht neben der laufenden (Bereitstellungsordner neben dem Code-Ordner): sie wird gebaut,
# gegen die Datenbank geprüft und einmal zur Probe gestartet – vorher gibt es eine Sicherung. Erst dann werden der
# Code-Ordner und Apache umgeschaltet; schlägt die Prüfung danach fehl, kommt automatisch die vorige Version zurück.
# Eine Installation mit der PHP-Version (2.x) zieht dabei auf Node.js um: die PHP-Seite läuft bis zum Umschalten weiter.

GIT=()
NEW="" BRANCH_NOW="" OLD_BRANCH="" OLD_REL="" PHP_REL="" STAGE="" NEW_CFG="" IN_PLACE=0 MIGRATE=0 BACKUP_DIR="" SWITCH_STATE="" CHECKED_OUT=0 APACHE_SWITCHED=0
UPDATED=0

# Der Stand mit der PHP-Version vor dem letzten Wechsel (git pull bzw. checkout des alten Installers)
php_release() {
  local i c
  for i in $(seq 1 20); do
    c=$("${GIT[@]}" rev-parse -q --verify "HEAD@{$i}^{commit}" 2>/dev/null) || break
    if "${GIT[@]}" cat-file -e "$c:lib/bootstrap.php" 2>/dev/null; then printf '%s' "$c"; return 0; fi
  done
  c=$("${GIT[@]}" rev-parse -q --verify "ORIG_HEAD^{commit}" 2>/dev/null) || return 1
  "${GIT[@]}" cat-file -e "$c:lib/bootstrap.php" 2>/dev/null && printf '%s' "$c"
}

# Code-Ordner auf eine Version: checkout_release COMMIT [BRANCH] – Vorgabe ist der Branch des Updates, leer heißt
# losgelöst (ohne Branch). Unversionierte Dateien bleiben.
checkout_release() {
  local branch=${2-$BRANCH_NOW}
  if [ -n "$branch" ]; then
    "${GIT[@]}" checkout -q -f -B "$branch" "$1"
  else
    "${GIT[@]}" checkout -q -f --detach "$1"
  fi
}

# Phase 1 (die laufende Version des Installers): neue Version holen – ohne den Code-Ordner zu ändern –, dann geht es
# mit dem Installer der neuen Version weiter
fetch_release() {
  local branch current rc=0 new url tmp
  bold "Getting the new version"
  current=$("${GIT[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
  [ "$current" != HEAD ] || current=main
  branch=$current
  if [ "$BRANCH_GIVEN" = 1 ]; then branch=$BRANCH; fi
  url=${OYS_REPO_URL:-origin}
  if ! "${GIT[@]}" fetch -q "$url" "+refs/heads/$branch:refs/remotes/origin/$branch" 2>/dev/null; then
    "${GIT[@]}" ls-remote --exit-code --heads "$url" "$branch" >/dev/null 2>&1 || rc=$?
    if [ "$BRANCH_GIVEN" = 1 ] || [ "$branch" = main ] || [ "$rc" != 2 ]; then
      fail "git fetch didn’t work (branch $branch) – see above. Nothing was changed."
    fi
    # 2 = den Branch gibt es nicht mehr (z. B. nach dem Merge gelöscht)
    info "The branch $branch is gone on GitHub (merged?) – switching to main."
    branch=main
    "${GIT[@]}" fetch -q "$url" "+refs/heads/main:refs/remotes/origin/main" || fail "git fetch didn’t work – see above."
  fi
  new=$("${GIT[@]}" rev-parse "refs/remotes/origin/$branch")
  # Wie git pull --ff-only: eigene Änderungen im Code-Ordner gehen nie verloren
  if [ -n "$("${GIT[@]}" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    fail "Files in $CODE were changed by hand (git status shows them) – nothing was changed. Undo the changes (git -C $CODE checkout -- .) or commit them first."
  fi
  if [ "$branch" = "$current" ] && ! "${GIT[@]}" merge-base --is-ancestor HEAD "$new" 2>/dev/null; then
    fail "$CODE has commits that aren’t on GitHub (git pull --ff-only would refuse too) – nothing was changed."
  fi
  if ! "${GIT[@]}" cat-file -e "$new:app/package.json" 2>/dev/null; then
    fail "The branch $branch still holds the PHP version – going back to it isn’t possible with --update (server/README.md: Restore a backup). Nothing was changed."
  fi
  tmp=$(mktemp)
  "${GIT[@]}" show "$new:server/install.sh" > "$tmp" || fail "The new installer couldn’t be read from git."
  exec env OYS_PULLED=1 OYS_RELEASE="$new" OYS_RELEASE_BRANCH="$branch" OYS_CODE="$CODE" OYS_INSTALLER_TMP="$tmp" bash "$tmp" --update
}

# Der alte Installer (PHP-Version) holt die neue Version mit git pull schon in den Code-Ordner – damit fehlen dort die
# PHP-Dateien. Bis zum Umschalten gehört die PHP-Version wieder dorthin; die neue entsteht nebenan.
keep_php_running() {
  if [ -z "$NEW" ]; then return 0; fi
  if [ -f "$CODE/lib/bootstrap.php" ]; then
    PHP_REL=$("${GIT[@]}" rev-parse HEAD)
    return 0
  fi
  if ! PHP_REL=$(php_release) || [ -z "$PHP_REL" ]; then
    PHP_REL=""
    warn "The PHP files are already gone and git doesn’t know the previous version – the website is offline until the update is done."
    return 0
  fi
  if ! checkout_release "$PHP_REL"; then
    PHP_REL=""
    warn "The PHP version couldn’t be put back – the website is offline until the update is done."
    return 0
  fi
  info "The PHP website runs again (version ${PHP_REL:0:7}) while the new version is prepared next to it."
}

# Neue Version auspacken: neben dem Code-Ordner (gleiches Dateisystem, nicht über das Web erreichbar). Ohne git (Code von
# Hand kopiert) liegt sie schon im Code-Ordner – dann wird dort gebaut; die neuen Einstellungen liegen bis zum Umschalten
# trotzdem außerhalb.
stage_release() {
  local dir
  dir=$(dirname "$CODE")/.$(basename "$CODE")-next
  rm -rf "$dir" "$DATA_DIR/next"
  if [ -n "$NEW" ]; then
    STAGE=$dir
    install -d -m 755 "$STAGE"
    "${GIT[@]}" archive --format=tar "$NEW" | tar -x -C "$STAGE" || fail "The new version couldn’t be unpacked – nothing was changed."
    NEW_CFG=$STAGE/config.json
  else
    STAGE=$CODE
    IN_PLACE=1
    install -d -m 750 -o root -g "$WEB" "$DATA_DIR" "$DATA_DIR/next"
    NEW_CFG=$DATA_DIR/next/config.json
  fi
  CONFIG_MJS=$STAGE/app/scripts/config.mjs
  NODE_SH=$STAGE/server/node.sh
}

# Mit den Zugangsdaten der Seite an die Datenbank (Passwort über eine Datei, nicht über die Befehlszeile)
db_as_site() {
  local f rc=0
  f=$(mktemp)
  printf '[client]\nuser=%s\npassword=%s\n' "$DB_USER" "$DB_PASS" > "$f"
  mariadb --defaults-extra-file="$f" "$DB_NAME" "$@" || rc=$?
  rm -f "$f"
  return "$rc"
}

schema_version() {
  mariadb -N "$DB_NAME" -e "SELECT meta_value FROM oys_meta WHERE meta_key = 'schema_version'" 2>/dev/null || true
}

# Nur lesen: Datenbank, Platz, Schema, Passwörter – ein Abbruch hier ändert nichts
preflight() {
  local need free uploads_kb v bad
  bold "Checking the server (nothing is changed yet)"
  load_db_pass
  [ -n "$DB_PASS" ] || fail "$(basename "$(cfg_file)") has no password for the database $DB_NAME – run the installer without --update. Nothing was changed."
  db_as_site -e 'SELECT 1' >/dev/null || fail "The database can’t be reached with the settings in $(basename "$(cfg_file)") – nothing was changed."
  # Platz für die Sicherung (die Uploads ganz, wenn es noch keine gibt) und die neue Version (etwa 1 GB)
  # du endet mit einem Fehler, wenn der Ordner fehlt oder eine Datei beim Zählen verschwindet (die Seite räumt auf) –
  # dann zählt, was es gezählt hat (set -e mit pipefail beendete sonst das Skript ohne Meldung)
  uploads_kb=$( { du -sk "$UPLOADS" 2>/dev/null || true; } | cut -f1)
  need=$((1024 * 1024))
  if [ ! -d "$BACKUPS/latest/uploads" ]; then need=$((need + ${uploads_kb:-0})); fi
  install -d -m 700 "$BACKUPS"
  free=$(df -Pk "$BACKUPS" | awk 'NR == 2 {print $4}')
  [ "${free:-0}" -ge "$need" ] || fail "Not enough disk space for the backup: $((${free:-0} / 1024)) MB free, about $((need / 1024)) MB needed. Nothing was changed."
  free=$(df -Pk "$(dirname "$CODE")" | awk 'NR == 2 {print $4}')
  [ "${free:-0}" -ge $((1024 * 1024)) ] || fail "Not enough disk space next to $CODE for the new version (about 1 GB). Nothing was changed."
  if [ "$MIGRATE" = 1 ]; then
    # Die PHP-Version bringt die Datenbank beim ersten Aufruf auf ihren Stand (4)
    v=$(schema_version)
    if [ "${v:-0}" -lt 4 ]; then
      curl -sk --noproxy '*' --max-time 90 --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null "https://$DOMAIN/" || true
      v=$(schema_version)
    fi
    [ "${v:-0}" -ge 4 ] || fail "The database is at version ${v:-0} – open the website once, then run the update again. Nothing was changed."
  fi
  # Node.js prüft bcrypt-Passwörter ($2y$, $2b$, $2a$) – andere, alte Formate kann es nicht prüfen
  bad=$(mariadb -N "$DB_NAME" -e "SELECT COUNT(*) FROM users WHERE password <> '' AND LEFT(password, 4) NOT IN ('\$2y\$', '\$2b\$', '\$2a\$')" 2>/dev/null || echo 0)
  if [ "${bad:-0}" -gt 0 ]; then
    warn "$bad accounts have an old kind of password hash that the new version can’t check – they couldn’t log in"
    warn "until an admin sets a new password for them (Admin → Users → Force Password Reset)."
    case "$(choose "Update anyway? [y/N]" n)" in
      [yY]*) ;;
      *) fail "Nothing was changed." ;;
    esac
  fi
  info "Database, disk space and passwords: all fine."
}

take_backup() {
  bold "Backup"
  info "Saving the database, the uploads and the settings first …"
  bash "$STAGE/server/backup.sh" "$1" | sed 's/^/  /' || fail "The backup didn’t work – nothing was changed."
  BACKUP_DIR=$(readlink -f "$BACKUPS/latest")
}

# Die neue Version einmal zur Probe starten: aus dem Bereitstellungsordner, als www-data, auf einem freien Port
stage_check() {
  local port log pid code="" end=$((SECONDS + ${WEB_WAIT:-60}))
  port=$("$NODE" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });')
  log=$(mktemp)
  setpriv --reuid="$WEB" --regid="$WEB" --init-groups -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/nonexistent NODE_ENV=production OYS_CONFIG="$NEW_CFG" HOST=127.0.0.1 PORT="$port" TMPDIR="$DATA_DIR/tmp" \
    "$NODE" "$STAGE/app/dist/server.js" >"$log" 2>&1 &
  pid=$!
  while [ "$SECONDS" -lt "$end" ]; do
    code=$(curl -s --noproxy '*' --max-time 5 -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" "http://127.0.0.1:$port/" 2>/dev/null || true)
    if [ "$code" = 200 ] || ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [ "$code" != 200 ]; then
    warn "The new version answered ${code:-nothing} – its output:"
    tail -n 25 "$log" | sed 's/^/    /'
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  info "The new version starts and answers (test run on port $port)."
}

# „Zeitstempel Signatur“ für eine Anfrage wie vom Discord-Bot (leer ohne bot_secret) – das Geheimnis bleibt in Node
bot_signature() {
  "$NODE" -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const s = String(c.bot_secret ?? "");
    if (s.length < 32) process.exit(0);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = require("crypto").createHmac("sha256", s).update(ts + "\n" + process.argv[2] + "\n" + process.argv[3] + "\n").digest("hex");
    process.stdout.write(ts + " " + sig);' "$CODE/config.json" "$1" "$2" 2>/dev/null || true
}

# Nach dem Umschalten über Apache prüfen, wie ein Besucher: Startseite, eine Seite als Subdomain und im Pfad, eine
# hochgeladene Datei, eine signierte Anfrage wie vom Bot und das Protokoll des Dienstes
verify_site() {
  local problems=() code slug file sig checked=()
  get() {
    curl -sk --noproxy '*' --max-time 30 --resolve "$1:443:127.0.0.1" -o /dev/null -w '%{http_code}' "${@:3}" "https://$1$2" 2>/dev/null || true
  }
  code=$(get "$DOMAIN" /)
  if [ "$code" = 200 ]; then checked+=("start page"); else problems+=("https://$DOMAIN/ answered ${code:-nothing}"); fi
  slug=$(mariadb -N "$DB_NAME" -e "SELECT slug FROM pages WHERE address_mode <> 'path' ORDER BY id LIMIT 1" 2>/dev/null || true)
  if [ -n "$slug" ]; then
    code=$(get "$slug.$DOMAIN" /)
    if [ "$code" = 200 ]; then checked+=("$slug.$DOMAIN"); else problems+=("https://$slug.$DOMAIN/ answered ${code:-nothing}"); fi
  fi
  slug=$(mariadb -N "$DB_NAME" -e "SELECT slug FROM pages WHERE address_mode = 'path' ORDER BY id LIMIT 1" 2>/dev/null || true)
  if [ -n "$slug" ]; then
    code=$(get "$DOMAIN" "/$slug")
    if [ "$code" = 200 ]; then checked+=("$DOMAIN/$slug"); else problems+=("https://$DOMAIN/$slug answered ${code:-nothing}"); fi
  fi
  file=$(find "$(uploads_dir)" -maxdepth 1 -type f -regextype posix-extended -regex '.*/[A-Za-z0-9][A-Za-z0-9._-]*\.(webp|png|jpe?g|gif|pdf|mp3)' -printf '%f\n' 2>/dev/null | head -n 1 || true)
  if [ -n "$file" ]; then
    code=$(get "$DOMAIN" "/static/uploads/$file")
    if [ "$code" = 200 ]; then checked+=("an upload"); else problems+=("https://$DOMAIN/static/uploads/$file answered ${code:-nothing}"); fi
  fi
  sig=$(bot_signature GET /_/bot/ping)
  if [ -n "$sig" ]; then
    code=$(get "$DOMAIN" /_/bot/ping -H "X-OYS-Timestamp: ${sig% *}" -H "X-OYS-Signature: ${sig#* }")
    if [ "$code" = 200 ]; then checked+=("the bot connection"); else problems+=("the signed /_/bot/ping answered ${code:-nothing}"); fi
  fi
  # Abstürze, fehlende Module oder Schreibverbote im Protokoll seit dem Start
  if journalctl -u onyoursite-web --since "@${SWITCH_SINCE:-0}" --no-pager 2>/dev/null \
      | grep -qE 'Uncaught|Cannot find module|ERR_MODULE_NOT_FOUND|EROFS|EACCES|FATAL ERROR'; then
    problems+=("the log of onyoursite-web shows errors (journalctl -u onyoursite-web)")
  fi
  if [ "${#problems[@]}" -gt 0 ]; then
    for code in "${problems[@]}"; do warn "  $code"; done
    return 1
  fi
  info "Checked through Apache: $(printf '%s, ' "${checked[@]}" | sed 's/, $//') – all fine."
}

# Die fertigen Teile der neuen Version in den Code-Ordner (Umbenennen auf demselben Dateisystem – Sekundensache)
put_build() {
  local d
  install -d -m 755 "$CODE/app"
  for d in node_modules dist; do
    if [ -e "$CODE/app/$d" ]; then mv "$CODE/app/$d" "$STAGE/app/$d.old"; fi
    mv "$STAGE/app/$d" "$CODE/app/$d"
  done
  # type: module – ohne package.json liest Node die übersetzten Dateien falsch
  if [ ! -f "$CODE/app/package.json" ]; then cp -p "$STAGE/app/package.json" "$CODE/app/package.json"; fi
}

# Umschalten. Vorher läuft nichts Neues; jeder Fehler ab hier führt über on_exit zu revert_release.
switch_release() {
  local t0 t1
  bold "Switching to the new version"
  install -d -m 700 "$CONF_DIR"
  install -m 600 "$SITE_CONF" "$PREVIOUS_SITE"
  if [ -f "$WEB_UNIT" ]; then cp -p "$WEB_UNIT" "$STAGE/web.service.old"; fi
  if [ -f "$CODE/config.json" ]; then cp -p "$CODE/config.json" "$STAGE/config.json.old"; fi
  rm -rf "$WEB_UNIT.d"
  SWITCH_STATE=prepared
  SWITCH_SINCE=$(date +%s)
  if [ "$MIGRATE" = 1 ]; then
    # 1. Node.js neben PHP starten: die fertige Version kommt nach app/, die Einstellungen bleiben bis zum Umschalten
    #    außerhalb des Code-Ordners (den PHP-Apache noch ausliefert) – PHP antwortet weiter
    if [ "$IN_PLACE" != 1 ]; then put_build; fi
    SWITCH_STATE=build
    PORT=$(web_port "$NEW_CFG")
    write_web_unit "$NEW_CFG" || true
    install -d -m 755 "$WEB_UNIT.d"
    printf '%s\n' "# OnYourSite – written by server/install.sh: settings of the new version until the switch" \
      "[Service]" "Environment=OYS_CONFIG=$NEW_CFG" > "$WEB_UNIT.d/next.conf"
    systemctl daemon-reload
    systemctl enable onyoursite-web >/dev/null 2>&1
    systemctl restart onyoursite-web
    SWITCH_STATE=node
    wait_web || { web_log 20; fail "The new version doesn’t answer on 127.0.0.1:$PORT."; }
    # 2. Apache-Datei für Node.js schreiben und prüfen – sie gilt erst nach dem Neuladen
    write_apache || true
    SWITCH_STATE=vhost
    apache_check || fail "The Apache configuration for the new version has an error (see above)."
    # 3. Umschalten: erst Apache neu laden – ab dann antwortet Node.js (es läuft schon, noch im Code-Ordner der
    #    PHP-Version), und PHP-Anfragen, die gerade laufen, finden ihre Dateien noch –, dann den Code-Ordner tauschen
    t0=$(date +%s%N)
    APACHE_SWITCHED=1
    systemctl reload apache2
    t1=$(date +%s%N)
    # Ab hier gehört beim Zurückgehen der vorige Stand wieder in den Code-Ordner (auch nach einem halben checkout)
    if [ "$IN_PLACE" != 1 ]; then CHECKED_OUT=1; checkout_release "$NEW"; fi
    SWITCH_STATE=code
    # Apache-Prozesse mit der PHP-Einstellung arbeiten Anfragen von vor dem Neuladen noch zu Ende (auch eine langsam
    # gesendete) und gäben dabei jede Datei im Code-Ordner aus – auch config.json. Diese Sperre lesen sie bei jeder
    # Anfrage; sie steht dort, bevor config.json kommt.
    deny_code_folder
    mv -f "$NEW_CFG" "$CODE/config.json"
    SWITCH_STATE=apache
    rm -rf "$WEB_UNIT.d"
    systemctl daemon-reload
  else
    t0=$(date +%s%N)
    # Erst anhalten, dann tauschen: die laufende Version soll nie aus einem halb getauschten Code-Ordner antworten
    # (Apache zeigt so lange „OnYourSite is restarting“)
    systemctl stop onyoursite-web
    SWITCH_STATE=stopped
    if [ "$IN_PLACE" != 1 ]; then CHECKED_OUT=1; checkout_release "$NEW"; put_build; fi
    mv -f "$NEW_CFG" "$CODE/config.json"
    SWITCH_STATE=code
    PORT=$(web_port)
    write_web_unit || true
    systemctl daemon-reload
    systemctl enable onyoursite-web >/dev/null 2>&1
    systemctl start onyoursite-web
    SWITCH_STATE=node
    wait_web || { web_log 20; fail "The new version doesn’t answer on 127.0.0.1:$PORT."; }
    t1=$(date +%s%N)
    if write_apache; then
      SWITCH_STATE=vhost
      apache_check || fail "The Apache configuration for the new version has an error (see above)."
      APACHE_SWITCHED=1
      systemctl reload apache2
    fi
    SWITCH_STATE=apache
  fi
  if [ -n "$NEW" ]; then
    "${GIT[@]}" branch -q --set-upstream-to="origin/$BRANCH_NOW" "$BRANCH_NOW" >/dev/null 2>&1 || true
  fi
  chown -R "$WEB:$WEB" "$CODE/email"
  chmod 750 "$CODE/email"
  info "Switched in $(( (t1 - t0) / 1000000 )) ms."
  verify_site || fail "The new version doesn’t work through Apache."
  SWITCH_STATE=finished
}

# Zurück zur vorigen Version (PHP oder Node), je nachdem, wie weit das Umschalten kam: erst der Code-Ordner, dann Apache,
# zuletzt der Dienst – so liefert Apache nie die Einstellungen aus, und die alte Seite antwortet so schnell wie möglich.
# Aufgerufen über on_exit (trap).
# shellcheck disable=SC2317
revert_release() {
  set +e
  local d log
  echo
  warn "The new version didn’t pass – going back to the previous one …"
  # Mit PHP zuerst die Einstellungen weg: die Dateien der PHP-Version kommen gleich zurück, und ihre .htaccess liefert
  # vorhandene Dateien aus (Apache-Prozesse von vor dem Umschalten können noch Anfragen bearbeiten)
  if [ "$MIGRATE" = 1 ]; then rm -f "$CODE/config.json"; fi
  if [ "$IN_PLACE" != 1 ]; then
    if [ "$CHECKED_OUT" = 1 ] && [ -n "$OLD_REL" ]; then checkout_release "$OLD_REL" "$OLD_BRANCH"; fi
    # Die neue Version nur beiseite legen (Umbenennen – sofort): gelöscht wird sie erst mit dem Bereitstellungsordner,
    # wenn die vorige Version schon wieder antwortet
    for d in node_modules dist; do
      if [ -e "$CODE/app/$d" ] && { [ -e "$STAGE/app/$d.old" ] || [ "$MIGRATE" = 1 ]; }; then
        mv "$CODE/app/$d" "$STAGE/app/$d.failed"
      fi
      if [ -e "$STAGE/app/$d.old" ]; then mv "$STAGE/app/$d.old" "$CODE/app/$d"; fi
    done
    if [ "$MIGRATE" = 1 ]; then
      if ! "${GIT[@]}" cat-file -e "$OLD_REL:app/package.json" 2>/dev/null; then rm -f "$CODE/app/package.json"; fi
      rmdir "$CODE/app" 2>/dev/null
    fi
  fi
  if [ "$MIGRATE" = 1 ]; then
    undeny_code_folder
  elif [ -f "$STAGE/config.json.old" ]; then
    mv -f "$STAGE/config.json.old" "$CODE/config.json"
  fi
  if [ -f "$PREVIOUS_SITE" ] && ! cmp -s "$PREVIOUS_SITE" "$SITE_CONF"; then
    install -m 644 "$PREVIOUS_SITE" "$SITE_CONF"
    if [ "$APACHE_SWITCHED" = 1 ]; then systemctl reload apache2; fi
  fi
  rm -f "$PREVIOUS_SITE"
  rm -rf "$WEB_UNIT.d"
  if [ "$MIGRATE" = 1 ]; then
    systemctl disable --now onyoursite-web >/dev/null 2>&1
    echo
    info "The log of the new version (journalctl -u onyoursite-web):"
    web_log 20
    rm -f "$WEB_UNIT"
    systemctl daemon-reload
    if [ -n "$PHPV" ]; then systemctl start "php$PHPV-fpm" >/dev/null 2>&1; fi
    echo
    info "The PHP website runs as before. The database only got additions the PHP version ignores."
  else
    # Das Protokoll der neuen Version vor dem Neustart festhalten, gezeigt wird es danach (die alte Seite zuerst)
    log=$(web_log 20)
    if [ -f "$STAGE/web.service.old" ]; then install -m 644 "$STAGE/web.service.old" "$WEB_UNIT"; fi
    systemctl daemon-reload
    if [ "$SWITCH_STATE" != prepared ]; then systemctl restart onyoursite-web; fi
    echo
    info "The log of the new version (journalctl -u onyoursite-web):"
    if [ -n "$log" ]; then printf '%s\n' "$log"; fi
    echo
    info "The previous version runs again${OLD_REL:+ (${OLD_REL:0:7})}."
  fi
  if [ -n "$BACKUP_DIR" ]; then info "The backup from before the update: $BACKUP_DIR"; fi
  SWITCH_STATE=reverted
}

# Beim Ende des Updates (auch bei Fehlern und Strg+C): zurück, falls mitten im Umschalten, und aufräumen
# shellcheck disable=SC2317
on_exit() {
  local rc=$?
  trap - EXIT
  case $SWITCH_STATE in
    ""|finished|reverted) ;;
    *) revert_release ;;
  esac
  if [ -n "$STAGE" ] && [ "$STAGE" != "$CODE" ]; then rm -rf "$STAGE"; fi
  rm -rf "$DATA_DIR/next"
  exit "$rc"
}

update_site() {
  local pending=0 label
  DOMAIN=$(conf_get DOMAIN)
  PHPV=$(conf_get PHP_VERSION)
  GIT=(git -c safe.directory="$CODE" -C "$CODE")
  if php_live; then MIGRATE=1; fi
  if [ -d "$CODE/.git" ]; then
    NEW=${OYS_RELEASE:-$("${GIT[@]}" rev-parse HEAD)}
    BRANCH_NOW=${OYS_RELEASE_BRANCH:-$("${GIT[@]}" rev-parse --abbrev-ref HEAD)}
    if [ "$BRANCH_NOW" = HEAD ]; then BRANCH_NOW=""; fi
    # Der Branch vor dem Update (mit --branch ein anderer) – geht es zurück, dann auch auf ihn
    OLD_BRANCH=$("${GIT[@]}" rev-parse --abbrev-ref HEAD)
    if [ "$OLD_BRANCH" = HEAD ]; then OLD_BRANCH=""; fi
  fi
  trap on_exit EXIT
  trap 'exit 130' INT TERM HUP
  if [ "$MIGRATE" = 1 ]; then
    bold "Moving OnYourSite from PHP to Node.js"
    info "The PHP website keeps running until the new version is built and checked."
    keep_php_running
  fi
  if [ -n "$NEW" ]; then OLD_REL=$("${GIT[@]}" rev-parse HEAD); fi
  stage_release
  step_packages
  preflight
  # Jedes Update beginnt mit einer Sicherung – auch ohne neue Version (Einstellungen, Dienst, Apache, Bot und Tunnel
  # werden trotzdem neu geschrieben)
  if [ "$MIGRATE" = 1 ]; then label='before-node'; else label='before-update'; fi
  take_backup "$label"

  # Nichts Neues? Dann nur Einstellungen, Dienst und Apache auf den Stand bringen
  if [ "$MIGRATE" = 0 ] && [ -n "$NEW" ] && [ "$NEW" = "$OLD_REL" ] && build_current "$CODE/app"; then
    app_cli "$CODE" "$CODE/config.json" migrate --pending >/dev/null || pending=$?
    if [ "$pending" = 0 ]; then
      rm -rf "$STAGE"
      STAGE=""
      CONFIG_MJS=$CODE/app/scripts/config.mjs
      update_settings_only
      return 0
    fi
  fi

  bold "Building the new version"
  write_config_json "$NEW_CFG" "$(cfg_file)"
  build_app "$STAGE/app" force || fail "The new version couldn’t be built – see above. The website keeps running as before."

  bold "Checking the new version with the data of this server"
  app_cli "$STAGE" "$NEW_CFG" check --crypto | sed 's/^/  /' \
    || fail "Encrypted data can’t be read with the key in the new settings – nothing was switched. The website keeps running as before."
  app_cli "$STAGE" "$NEW_CFG" migrate | sed 's/^/  /' \
    || fail "The database couldn’t be updated – see above. The website keeps running as before; the backup is in $BACKUP_DIR."
  stage_check || fail "The new version doesn’t start – see above. The website keeps running as before."

  switch_release
  UPDATED=1
  if [ "$MIGRATE" = 1 ]; then retire_php; fi
  update_finish
}

# Nach dem Umschalten (oder ohne neue Version): Tunnel, Schutz, Timer, Einstellungen, Bot, Prüfung
update_finish() {
  if [ "$TUNNEL" = yes ]; then
    bold "Cloudflare tunnel"
    tunnel_local
    info "cloudflared is up to date and running."
  fi
  bold "Protection, backups and weekly report"
  step_protect
  write_timers
  save_conf
  step_bot
  bold "Checking the website"
  check_site
  bold "Done."
  if [ "$MIGRATE" = 1 ]; then
    info "OnYourSite now runs on Node.js (service onyoursite-web) – PHP isn’t used any more."
    info "Everyone has to log in once more: the logins of the PHP version don’t carry over."
  elif [ "$UPDATED" = 1 ]; then
    info "OnYourSite is updated to version ${NEW:0:7}."
  fi
  if [ -n "$BACKUP_DIR" ]; then info "Backup from before the update: $BACKUP_DIR (to restore it: server/README.md)"; fi
  info "Errors:   journalctl -u onyoursite-web -f"
}

# Keine neue Version: Einstellungen, Dienst und Apache wie gewünscht (ändert nur, was nicht stimmt)
update_settings_only() {
  local restart=0 old_cfg
  bold "Website"
  info "OnYourSite is up to date (version ${NEW:0:7})."
  old_cfg=$(cat "$CODE/config.json")
  write_config_json "$CODE/config.json"
  if [ "$(cat "$CODE/config.json")" != "$old_cfg" ]; then restart=1; fi
  PORT=$(web_port)
  if write_web_unit; then restart=1; fi
  systemctl daemon-reload
  systemctl enable onyoursite-web >/dev/null 2>&1
  if [ "$restart" = 1 ] || ! systemctl is-active --quiet onyoursite-web; then
    systemctl restart onyoursite-web
    wait_web || { web_log 30; fail "The website doesn’t start – see its log above."; }
  fi
  if write_apache; then
    apache_check || fail "The Apache configuration has an error (see above)."
    systemctl reload apache2
  fi
  update_finish
}

# ---------------------------------------------------------------
ARGS=("$@")
if [ ! -f "${BASH_SOURCE[0]:-}" ]; then
  # Per Pipe gestartet (curl … | sudo bash): die Antworten kommen von der Tastatur, den Code holt get_code
  [ "$(id -u)" -eq 0 ] || fail "Please start it with sudo: curl -fsSL https://raw.githubusercontent.com/$REPO/main/server/install.sh | sudo bash"
  if (: < /dev/tty) 2>/dev/null; then exec < /dev/tty; fi
  CODE=""
elif [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || fail "Please run this as root."
  exec sudo bash "$0" "$@"
fi
# Die Zwischendatei, aus der ein Update den neuen Installer startet, wird nicht mehr gebraucht (bash hat alles gelesen)
if [ -n "${OYS_INSTALLER_TMP:-}" ]; then rm -f "$OYS_INSTALLER_TMP"; fi
# Nie zwei Läufe gleichzeitig (sie würden sich den Bereitstellungsordner und die Dienste wegnehmen). Die Sperre gilt bis
# zum Ende – auch über exec in den Installer der neuen Version hinweg.
if [ -z "${OYS_INSTALL_LOCKED:-}" ] && command -v flock >/dev/null 2>&1; then
  install -d -m 755 /run/lock
  exec 8>/run/lock/onyoursite-install.lock
  flock -n 8 || fail "The installer is already running (another terminal?) – wait until it is done and try again."
  export OYS_INSTALL_LOCKED=1
fi

# In Meldungen: „sudo“ nur, wenn über sudo gestartet (als root angemeldet gibt es oft gar kein sudo)
SUDO_HINT=""
if [ -n "${SUDO_USER:-}" ]; then SUDO_HINT="sudo "; fi

MODE=install
BRANCH_GIVEN=0
while [ $# -gt 0 ]; do
  case $1 in
    --update) MODE=update ;;
    --https) MODE=https ;;
    --tunnel) MODE=tunnel ;;
    --reset) MODE=reset ;;
    --branch)
      [[ ${2:-} =~ ^[A-Za-z0-9_][A-Za-z0-9._/-]*$ ]] || fail "--branch needs the name of a branch."
      BRANCH=$2
      BRANCH_GIVEN=1
      shift ;;
    *) fail "Unknown option: $1 (use --update, --https, --tunnel, --reset, --branch NAME or nothing)" ;;
  esac
  shift
done
if [ ! -f "$CODE/app/package.json" ] || [ ! -f "$CODE/server/install.sh" ]; then
  [ "$MODE" = install ] || fail "Run this inside the code folder: ${SUDO_HINT}bash $TARGET/server/install.sh ${ARGS[*]}"
  get_code "${ARGS[@]}"
fi
CONFIG_MJS=$CODE/app/scripts/config.mjs

SSH_KEYONLY=$(conf_get SSH_KEYONLY)
TUNNEL=$(conf_get TUNNEL)
TUNNEL_ID=$(conf_get TUNNEL_ID)
# Eingerichtet ist der Server erst mit einer Domain in server.conf – ein abgebrochener erster Lauf kann dort schon
# die Tunnel-ID gespeichert haben
OLD_DOMAIN=$(conf_get DOMAIN)
DB_EMPTY=0
DB_IMPORTED=0
BACKUP_DAYS=$(conf_get BACKUP_DAYS)
BACKUP_DAYS=${BACKUP_DAYS:-14}
IMPORT="" IMP_CONFIG="" IMP_SMTP="" IMP_DUMP="" IMP_UPLOADS=""
PROBE_TUNNEL=""
PORT=3000
PHPV=""

# Alles außer der Einrichtung nur aus dem eingerichteten Code-Ordner – sonst landen Pfade eines anderen Ordners
# (z. B. eines zweiten git clone) in server.conf und in den Timern
if [ "$MODE" != install ] && [ -n "$(conf_get CODE)" ] && [ "$(conf_get CODE)" != "$CODE" ]; then
  fail "Run this from the installed code folder: ${SUDO_HINT}bash $(conf_get CODE)/server/install.sh ${ARGS[*]}"
fi
# Node.js, mit dem der Server eingerichtet wurde (für --https, --tunnel, --reset; Einrichten und Update prüfen es neu)
NODE=$(conf_get NODE)
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  # shellcheck source=server/node.sh
  . "$CODE/server/node.sh"
  NODE=$(node_find "$NODE_MAJOR" || true)
fi
if [ -n "$NODE" ]; then NODE_BIN=$(dirname "$NODE"); fi

case $MODE in
  install)
    # Läuft hier noch die PHP-Version, zieht nur --update sicher um (die PHP-Seite läuft dabei weiter)
    if php_live; then fail "This server still runs the PHP version of OnYourSite – move it to Node.js with: ${SUDO_HINT}bash $CODE/server/install.sh --update"; fi
    check_location "${ARGS[@]}"
    step_packages
    step_settings
    step_database
    step_website
    step_tunnel
    step_https
    step_services
    if [ "$PROBE_TUNNEL" = 1 ]; then tunnel_probe; fi
    save_conf
    step_admin
    step_bot
    summary
    ;;
  update)
    [ -n "$OLD_DOMAIN" ] || fail "OnYourSite isn’t set up on this server yet. Run: ${SUDO_HINT}bash $CODE/server/install.sh"
    if [ -d "$CODE/.git" ] && [ -z "${OYS_PULLED:-}" ]; then
      GIT=(git -c safe.directory="$CODE" -C "$CODE")
      fetch_release
    fi
    update_site
    ;;
  https)
    [ -n "$OLD_DOMAIN" ] || fail "OnYourSite isn’t set up on this server yet. Run: ${SUDO_HINT}bash $CODE/server/install.sh"
    DOMAIN=$(conf_get DOMAIN)
    ensure_cert
    step_https force
    write_timers
    ;;
  tunnel)
    [ -n "$OLD_DOMAIN" ] || fail "OnYourSite isn’t set up on this server yet. Run: ${SUDO_HINT}bash $CODE/server/install.sh"
    DOMAIN=$(conf_get DOMAIN)
    step_tunnel force
    bold "7/9  Protection"
    step_protect
    if [ "$PROBE_TUNNEL" = 1 ]; then tunnel_probe; fi
    save_conf
    bold "Checking the website"
    check_site
    ;;
  reset)
    [ -n "$OLD_DOMAIN" ] || fail "OnYourSite isn’t set up on this server – there is nothing to reset."
    DOMAIN=$(conf_get DOMAIN)
    if [ "$(conf_get CODE)" != "$CODE" ] || [ ! -f "$CODE/config.json" ]; then
      fail "Run this from the installed code folder: ${SUDO_HINT}bash $(conf_get CODE)/server/install.sh --reset"
    fi
    if php_live; then fail "This server still runs the PHP version – update it first: ${SUDO_HINT}bash $CODE/server/install.sh --update"; fi
    [ -n "$NODE" ] || fail "Node.js is missing – run the installer without --reset."
    bold "Start from scratch"
    warn "This deletes all OnYourSite data on this server: the database (accounts, pages, stats, messages,"
    warn "suggestions, tickets), all uploads and the keys in config.json."
    info "A backup is made first: $BACKUPS/<date>-<time>-before-reset (kept $BACKUP_DAYS days)."
    info "The code, the certificate, the Cloudflare tunnel, the mail server settings and the Discord bot settings stay."
    answer=""
    prompt answer "To confirm, type the domain ($DOMAIN):"
    [ "$answer" = "$DOMAIN" ] || fail "Not confirmed – nothing was deleted."
    info "Making a backup …"
    bash "$CODE/server/backup.sh" before-reset || fail "The backup didn’t work – nothing was deleted."
    # Die Webseite hält Verbindungen und Einstellungen – sie startet gleich mit den neuen wieder
    systemctl stop onyoursite-web >/dev/null 2>&1 || true
    mariadb -e "DROP DATABASE IF EXISTS \`$DB_NAME\`"
    find "$UPLOADS" -mindepth 1 -delete
    # Neue Schlüssel: der Installer legt sie gleich neu an. bot_secret bleibt – den hat der Bot auch.
    "$NODE" "$CONFIG_MJS" reset-keys --file "$CODE/config.json" || fail "The keys in config.json couldn’t be removed – see above."
    info "Everything is deleted – setting OnYourSite up fresh …"
    exec bash "$CODE/server/install.sh"
    ;;
esac
exit 0
}
