#!/usr/bin/env bash
# OnYourSite auf einem eigenen Server (ohne Plesk) – richtet alles auf einem frischen Ubuntu- oder Debian-Server ein.
#
#   curl -fsSL https://raw.githubusercontent.com/PwiePixel/OnYourSite/main/server/install.sh | sudo bash
#                                          Einrichten mit einem Befehl: holt sich alles selbst – Pakete, den Code von
#                                          GitHub, Datenbank, Zertifikat, Firewall. Geht auch als Datei: sudo bash install.sh
#                                          Erneut aufgerufen: Einstellungen ändern (Enter behält die Werte).
#                                          --branch NAME holt einen anderen Branch (z. B. zum Testen vor dem Merge).
#   sudo bash server/install.sh --update   Neue Version holen (git pull) und neu laden – Daten und Einstellungen bleiben
#   sudo bash server/install.sh --https    Nur das Zertifikat einrichten (nach „Later“ oder bei einem neuen DNS-Anbieter)
#
# Apache mit PHP-FPM (die .htaccess gilt wie bei Plesk), MariaDB, ein Let’s-Encrypt-Zertifikat für die Domain und alle
# Subdomains (über die DNS-API des Domain-Anbieters), Wochenbericht, nächtliche Sicherung und Zertifikats-Erneuerung als
# systemd-Timer, Firewall, fail2ban und weitere Absicherung, das erste Admin-Konto – und auf Wunsch der Umzug der Daten
# vom alten Server. Anleitung: server/README.md

# Alles steht in einem Block: bash liest so das ganze Skript, bevor es startet. Das braucht „curl … | sudo bash“
# (danach kommen die Antworten von der Tastatur), und ein git pull ändert so nichts am laufenden Skript.
{
set -euo pipefail
umask 022
# Pakete immer ohne Rückfragen installieren – auch die Programme, die apt nebenbei startet
# (debconf, apt-listchanges bei Debian, needrestart bei Ubuntu), sonst warten sie unsichtbar auf eine Taste
export DEBIAN_FRONTEND=noninteractive APT_LISTCHANGES_FRONTEND=none NEEDRESTART_MODE=a

# Bei „bash <(curl …)“ oder „bash /dev/stdin“ gibt es keinen Ordner – dann leer, get_code holt den Code
CODE=$( { cd "$(dirname "$(readlink -f "$0" 2>/dev/null)")/.." 2>/dev/null && pwd; } || true)
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
  local i
  if command -v cloud-init >/dev/null 2>&1; then timeout 900 cloud-init status --wait >/dev/null 2>&1 || true; fi
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
    echo "PHP_VERSION=$PHPV"
    echo "SSH_KEYONLY=$SSH_KEYONLY"
    echo "BACKUP_DAYS=$BACKUP_DAYS"
  } > "$tmp"
  mv "$tmp" "$CONF"
}

# Wert aus einer config.php lesen (z. B. db.pass) – leer, wenn es ihn nicht gibt
php_cfg() {
  [ -f "$1" ] || return 0
  # shellcheck disable=SC2016
  php -r '$c = @include $argv[1]; foreach (explode(".", $argv[2]) as $k) { $c = is_array($c) && array_key_exists($k, $c) ? $c[$k] : ""; } echo is_scalar($c) ? $c : "";' -- "$1" "$2" 2>/dev/null || true
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
      if runuser -u "$WEB" -- test -r "$CODE/index.php" 2>/dev/null; then return 0; fi
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
  bold "1/8  Packages"
  local id
  # shellcheck source=/dev/null
  id=$(. /etc/os-release && echo "${ID:-}")
  case $id in
    ubuntu|debian) ;;
    *) fail "This installer is made for Ubuntu (22.04 or newer) and Debian (12 or newer)." ;;
  esac
  { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; } || fail "This server doesn’t use systemd."
  export DEBIAN_FRONTEND=noninteractive
  info "Installing Apache, PHP, MariaDB and a few tools – the first time this takes a few minutes …"
  apt_update
  apt_install apache2 mariadb-server php-fpm php-cli php-mysql php-mbstring php-gd php-curl php-zip \
    git curl unzip rsync openssl ca-certificates bind9-dnsutils
  PHPV=$(php -r 'echo PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION;')
  info "Apache $(apache2ctl -v 2>/dev/null | sed -n 's/^Server version: Apache\/\([0-9.]*\).*/\1/p'), PHP $PHPV, MariaDB $(mariadb -N -e 'SELECT VERSION()' 2>/dev/null | cut -d- -f1)"
}

# ---------------------------------------------------------------
step_settings() {
  bold "2/8  Settings"
  local def
  def=$(conf_get DOMAIN)
  [ -n "$def" ] || def=$(php_cfg "$CODE/config.php" base_domain | cut -d: -f1)
  case $def in ""|*.test|localhost) def=on-your.site ;; esac
  while true; do
    prompt DOMAIN "Domain of the website, without www [$def]:"
    DOMAIN=$(printf '%s' "${DOMAIN:-$def}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
    if [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$ ]]; then break; fi
    info "  Please enter a domain like on-your.site"
  done

  IMPORT="" IMP_CONFIG="" IMP_SMTP="" IMP_DUMP="" IMP_UPLOADS=""
  local dir_def=""
  if [ ! -f "$CONF" ] && [ -d /root/import ]; then dir_def=/root/import; fi
  echo
  info "Moving from another server? Put these files from the old server into one folder (e.g. /root/import):"
  info "  config.php, email/smtp.json, the database dump (.sql, .sql.gz or .zip) and the uploads ZIP"
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
      info "  The database needs the old config.php next to it: it holds the key for encrypted data (aes_key)."
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
  if [ -f "$dir/config.php" ]; then IMP_CONFIG=$dir/config.php; fi
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
  bold "3/8  Database"
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
  if [ "$(php_cfg "$CODE/config.php" db.user)" = "$DB_USER" ] && [ "$(php_cfg "$CODE/config.php" db.name)" = "$DB_NAME" ]; then
    DB_PASS=$(php_cfg "$CODE/config.php" db.pass)
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
# config.php schreiben: bisherige Werte (beim Umzug die vom alten Server) bleiben – nur Datenbank, Domain und
# Upload-Ordner setzt der Installer. Passwort und Bot-Geheimnis kommen über die Umgebung (nicht in der Prozessliste).
write_config() {
  local old=$1 bot_secret=$2 script tmp
  script=$(mktemp)
  cat > "$script" <<'PHP'
<?php
[, $current, $old, $domain, $uploads, $dbName, $dbUser] = $argv;
$load = function (string $file): array {
    if ($file === '' || !is_file($file)) {
        return [];
    }
    $c = include $file;
    return is_array($c) ? $c : [];
};
$cfg = array_replace([
    'db' => [],
    'aes_key' => '',
    'app_secret' => '',
    'base_domain' => $domain,
    'scheme' => 'https',
    'timezone' => 'Europe/Berlin',
    'max_pages' => 3,
    'cron_secret' => '',
    'bot_secret' => '',
    'debug' => false,
], $load($current), $load($old));
if ((string) $cfg['aes_key'] === '') {
    $cfg['aes_key'] = bin2hex(random_bytes(16));
}
if ((string) $cfg['app_secret'] === '') {
    $cfg['app_secret'] = bin2hex(random_bytes(32));
}
if ((string) getenv('OYS_BOT_SECRET') !== '') {
    $cfg['bot_secret'] = getenv('OYS_BOT_SECRET');
}
$cfg['db'] = ['host' => 'localhost', 'name' => $dbName, 'user' => $dbUser, 'pass' => (string) getenv('OYS_DB_PASS')];
$cfg['base_domain'] = $domain;
$cfg['scheme'] = 'https';
$cfg['uploads_dir'] = $uploads;
$export = function ($value, string $indent = '') use (&$export): string {
    if (!is_array($value)) {
        return var_export($value, true);
    }
    $out = "[\n";
    foreach ($value as $k => $v) {
        $out .= $indent . '    ' . var_export($k, true) . ' => ' . $export($v, $indent . '    ') . ",\n";
    }
    return $out . $indent . ']';
};
echo "<?php\n"
    . "// OnYourSite – settings. Written by server/install.sh, which keeps these values when it runs again.\n"
    . "// What each setting means: config.example.php. Keep this file private: it holds the database password\n"
    . "// and the key for encrypted data (aes_key) – without that key, encrypted data can’t be read.\n"
    . 'return ' . $export($cfg) . ";\n";
PHP
  tmp=$(mktemp "$CODE/.config.php.XXXXXX")
  if ! OYS_DB_PASS=$DB_PASS OYS_BOT_SECRET=$bot_secret php "$script" "$CODE/config.php" "$old" "$DOMAIN" "$UPLOADS" "$DB_NAME" "$DB_USER" > "$tmp" \
      || ! php -l "$tmp" >/dev/null 2>&1; then
    rm -f "$tmp" "$script"
    fail "config.php couldn’t be written."
  fi
  rm -f "$script"
  chown root:"$WEB" "$tmp"
  chmod 640 "$tmp"
  # Die vorige Fassung bleibt für den Notfall (nur root): /etc/onyoursite/config.php.previous
  if [ -f "$CODE/config.php" ] && ! cmp -s "$tmp" "$CODE/config.php"; then
    install -d -m 700 "$CONF_DIR"
    install -m 600 "$CODE/config.php" "$CONF_DIR/config.php.previous"
  fi
  mv "$tmp" "$CODE/config.php"
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
  info "$count uploaded files copied to $UPLOADS"
}

write_php() {
  local ini=/etc/php/$PHPV/fpm/conf.d/90-onyoursite.ini pool=/etc/php/$PHPV/fpm/pool.d/www.conf mem children
  cat > "$ini" <<EOF
; OnYourSite – written by server/install.sh
; Music for the entrance can be up to 15 MB
upload_max_filesize = 16M
post_max_size = 20M
memory_limit = 256M
max_execution_time = 60
expose_php = Off
; The website never starts other programs – so PHP may not either
disable_functions = exec,shell_exec,system,passthru,proc_open,popen,pcntl_exec
session.use_strict_mode = 1
opcache.enable = 1
opcache.memory_consumption = 128
opcache.validate_timestamps = 1
opcache.revalidate_freq = 2
EOF
  # Gleichzeitige PHP-Prozesse nach Arbeitsspeicher (etwa 80 MB je Prozess, 5 bis 40)
  mem=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)
  children=$((mem / 80))
  if [ "$children" -lt 5 ]; then children=5; fi
  if [ "$children" -gt 40 ]; then children=40; fi
  sed -i -E "s/^;?pm\.max_children = .*/pm.max_children = $children/; s/^;?pm\.max_requests = .*/pm.max_requests = 500/" "$pool"
}

write_apache() {
  local sock=/run/php/php$PHPV-fpm.sock code_re
  # shellcheck disable=SC2016
  code_re=$(printf '%s' "$CODE" | sed 's/[.[\*^$()+?{|]/\\&/g')
  cat > "$SITE_CONF" <<EOF
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
    DocumentRoot $CODE
    Protocols h2 http/1.1
    # Uploads are at most 16 MB – bigger requests never reach PHP
    LimitRequestBody 26214400

    SSLEngine on
    SSLProtocol -all +TLSv1.2 +TLSv1.3
    SSLCertificateFile $SSL_DIR/fullchain.pem
    SSLCertificateKeyFile $SSL_DIR/privkey.pem

    <Directory $CODE>
        Options -Indexes +FollowSymLinks -MultiViews
        AllowOverride All
        Require all granted
    </Directory>
    # Internal folders and hidden files – the .htaccess blocks them too, this is the second lock
    <DirectoryMatch "^$code_re/(\.git|lib|cron|email|PHPMailer|tests|views|discord-bot|server)(/|$)">
        Require all denied
    </DirectoryMatch>
    <FilesMatch "^(\..*|config(\.example)?\.php)$">
        Require all denied
    </FilesMatch>
    <FilesMatch "\.php$">
        SetHandler "proxy:unix:$sock|fcgi://localhost"
    </FilesMatch>

    ErrorLog \${APACHE_LOG_DIR}/onyoursite-error.log
    CustomLog \${APACHE_LOG_DIR}/onyoursite-access.log onyoursite
</VirtualHost>
EOF
  local m
  for m in /etc/apache2/mods-enabled/php*.load; do
    if [ -e "$m" ]; then a2dismod -q "$(basename "$m" .load)" >/dev/null; fi
  done
  for m in mpm_prefork mpm_worker; do
    if [ -e "/etc/apache2/mods-enabled/$m.load" ]; then a2dismod -q "$m" >/dev/null; fi
  done
  a2enmod -q mpm_event ssl rewrite headers http2 proxy_fcgi setenvif >/dev/null
  for m in 000-default default-ssl; do
    if [ -e "/etc/apache2/sites-enabled/$m.conf" ]; then a2dissite -q "$m" >/dev/null; fi
  done
  a2ensite -q onyoursite >/dev/null
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

step_website() {
  bold "4/8  Website"
  # Root-Timer und git pull laufen aus diesem Ordner – niemand außer root darf darin etwas ändern.
  # Vor write_config, das config.php danach root und dem Webserver gibt.
  chown -R root:root "$CODE"
  local cfg_from=""
  if [ -n "$IMP_CONFIG" ]; then
    # Die Schlüssel der alten config.php gehören zu ihrer Datenbank
    if [ "$DB_IMPORTED" = 1 ] || [ "$DB_EMPTY" = 1 ]; then
      cfg_from=$IMP_CONFIG
    else
      warn "The old config.php isn’t used: its keys belong to its database, which wasn’t imported."
    fi
  fi
  write_config "$cfg_from" ""
  info "config.php is written (readable only by root and the web server)."
  # Der Code gehört root – schreiben darf der Webserver nur in den Upload-Ordner und in email/ (Mail-Einstellungen)
  install -d -m 750 -o root -g "$WEB" "$DATA_DIR"
  install -d -m 750 -o "$WEB" -g "$WEB" "$UPLOADS"
  find "$CODE" \( -path "$CODE/config.php" -o -path "$CODE/email" -o -name '.env' -o -name '.env.*' \) -prune \
    -o ! -type l -exec chmod go+rX,go-w {} +
  chown -R "$WEB:$WEB" "$CODE/email"
  chmod 750 "$CODE/email"
  if [ -n "$IMP_SMTP" ]; then
    rm -f "$CODE/email/smtp.json"
    install -m 640 -o "$WEB" -g "$WEB" "$IMP_SMTP" "$CODE/email/smtp.json"
    info "Mail server settings (smtp.json) copied."
  fi
  # email/ gehört dem Webserver: nur eine echte Datei anfassen, nie einem Symlink folgen
  if [ -f "$CODE/email/smtp.json" ] && [ ! -L "$CODE/email/smtp.json" ]; then chmod 640 "$CODE/email/smtp.json"; fi
  if [ -n "$IMP_UPLOADS" ]; then import_uploads "$IMP_UPLOADS"; fi
  write_php
  write_apache
  ensure_cert
  systemctl enable "php$PHPV-fpm" apache2 >/dev/null 2>&1
  if ! apache2ctl configtest >/dev/null 2>&1; then
    apache2ctl configtest || true
    fail "The Apache configuration has an error (see above)."
  fi
  if [ "$MODE" = update ]; then
    systemctl reload "php$PHPV-fpm"
    systemctl reload apache2
  else
    systemctl restart "php$PHPV-fpm"
    systemctl restart apache2
  fi
  info "Apache and PHP $PHPV are running – uploads: $UPLOADS"
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
  bold "5/8  HTTPS certificate"
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
  env "${creds[@]}" "$ACME" "${args[@]}" || rc=$?
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
write_timers() {
  local tz
  tz=$(php_cfg "$CODE/config.php" timezone)
  if [ -z "$tz" ] || [ ! -f "/usr/share/zoneinfo/$tz" ]; then tz=""; fi
  cat > "$UNITS/onyoursite-weekly-report.service" <<EOF
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite weekly report emails
After=mariadb.service

[Service]
Type=oneshot
User=$WEB
Group=$WEB
ExecStart=/usr/bin/php $CODE/cron/weekly_report.php
EOF
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

# Datei nur schreiben, wenn sich der Inhalt ändert (Inhalt kommt über stdin) – 0 = geändert
write_if_changed() {
  local tmp
  tmp=$(mktemp)
  cat > "$tmp"
  if [ -f "$1" ] && cmp -s "$tmp" "$1"; then
    rm -f "$tmp"
    return 1
  fi
  install -m 644 "$tmp" "$1"
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
  ufw allow 80/tcp comment HTTP >/dev/null
  ufw allow 443/tcp comment HTTPS >/dev/null
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
  info "Firewall: only SSH (port $ports), HTTP and HTTPS get through."
  info "fail2ban: 5 wrong SSH logins in 10 minutes = blocked for an hour. Security updates install by themselves."
  info "The database only answers this server, PHP can’t start programs, network settings are hardened."
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
  bold "6/8  Protection, backups and weekly report"
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
  bold "7/8  Admin account"
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
    # Die Angaben gehen über die Umgebung an PHP, nicht über die Befehlszeile
    if out=$(OYS_NAME=$name OYS_EMAIL=$email OYS_SLUG=$slug OYS_PASSWORD=$pw runuser -u "$WEB" -- php "$CODE/server/create-admin.php" 2>&1); then
      info "$out"
      return 0
    fi
    info "  $out"
  done
}

# ---------------------------------------------------------------
step_bot() {
  local secret
  bold "8/8  Discord bot"
  if [ -f "$UNITS/onyoursite-bot.service" ]; then
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
  secret=$(php_cfg "$CODE/config.php" bot_secret)
  if [ "${#secret}" -lt 32 ]; then
    secret=$(openssl rand -hex 32)
    write_config "" "$secret"
    info "A new bot_secret is in config.php."
  fi
  OYS_SITE_URL="https://$DOMAIN" OYS_BOT_SECRET=$secret bash "$CODE/discord-bot/install.sh" --service \
    || warn "The bot isn’t running yet – see above. Its installer can run again any time: ${SUDO_HINT}bash $CODE/discord-bot/install.sh"
}

check_site() {
  local code
  # Der erste Aufruf legt neue Tabellen an bzw. bringt importierte Daten auf den neuen Stand
  code=$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 90 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || true)
  if [ "$code" = 200 ]; then
    info "The website answers on this server."
  else
    warn "The website answered with ${code:-nothing} – the last errors:"
    tail -n 15 /var/log/apache2/onyoursite-error.log 2>/dev/null | sed 's/^/    /' || true
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
  if ! points_here; then
    echo
    info "If the DNS of $DOMAIN doesn’t point to this server yet, change it at your DNS provider:"
    info "  A     @, www and *   ${v4:-<public IPv4 of this server>}"
    if [ -n "$v6" ]; then info "  AAAA  @, www and *   $v6"; fi
    info "Test it before switching – add this line to the hosts file of your computer:"
    info "  ${v4:-<IPv4>}  $DOMAIN www.$DOMAIN yourname.$DOMAIN"
  fi
  if cert_temporary; then
    warn "HTTPS still uses a temporary certificate. Set up the real one: ${SUDO_HINT}bash $CODE/server/install.sh --https"
  fi
  echo
  info "Update:   ${SUDO_HINT}bash $CODE/server/install.sh --update"
  info "Backups:  $BACKUPS – every night, kept $BACKUP_DAYS days. Copy them off the server now and then."
  info "Errors:   /var/log/apache2/onyoursite-error.log"
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
  if [ -f "$TARGET/index.php" ] && [ -f "$TARGET/lib/bootstrap.php" ] && [ -f "$TARGET/server/install.sh" ]; then
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
  if [ ! -f "$TARGET/server/install.sh" ] || [ ! -f "$TARGET/lib/bootstrap.php" ]; then
    rm -rf "$TARGET"
    fail "The branch $BRANCH doesn’t contain the installer (server/install.sh) – nothing was installed."
  fi
  info "The code is in $TARGET (branch $BRANCH)."
  exec bash "$TARGET/server/install.sh" "$@"
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

# In Meldungen: „sudo“ nur, wenn über sudo gestartet (als root angemeldet gibt es oft gar kein sudo)
SUDO_HINT=""
if [ -n "${SUDO_USER:-}" ]; then SUDO_HINT="sudo "; fi

MODE=install
BRANCH_GIVEN=0
while [ $# -gt 0 ]; do
  case $1 in
    --update) MODE=update ;;
    --https) MODE=https ;;
    --branch)
      [[ ${2:-} =~ ^[A-Za-z0-9_][A-Za-z0-9._/-]*$ ]] || fail "--branch needs the name of a branch."
      BRANCH=$2
      BRANCH_GIVEN=1
      shift ;;
    *) fail "Unknown option: $1 (use --update, --https, --branch NAME or nothing)" ;;
  esac
  shift
done
if [ ! -f "$CODE/index.php" ] || [ ! -f "$CODE/lib/bootstrap.php" ]; then
  [ "$MODE" = install ] || fail "Run this inside the code folder: ${SUDO_HINT}bash $TARGET/server/install.sh ${ARGS[*]}"
  get_code "${ARGS[@]}"
fi

SSH_KEYONLY=$(conf_get SSH_KEYONLY)
OLD_DOMAIN=$(conf_get DOMAIN)
DB_EMPTY=0
DB_IMPORTED=0
BACKUP_DAYS=$(conf_get BACKUP_DAYS)
BACKUP_DAYS=${BACKUP_DAYS:-14}
IMPORT="" IMP_CONFIG="" IMP_SMTP="" IMP_DUMP="" IMP_UPLOADS=""

case $MODE in
  install)
    check_location "${ARGS[@]}"
    step_packages
    step_settings
    step_database
    step_website
    step_https
    step_services
    save_conf
    step_admin
    step_bot
    summary
    ;;
  update)
    [ -f "$CONF" ] || fail "OnYourSite isn’t set up on this server yet. Run: ${SUDO_HINT}bash $CODE/server/install.sh"
    DOMAIN=$(conf_get DOMAIN)
    if [ -d "$CODE/.git" ] && [ -z "${OYS_PULLED:-}" ]; then
      bold "Getting the new version"
      git_c=(git -c safe.directory="$CODE" -C "$CODE")
      branch=$("${git_c[@]}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
      rc=0
      "${git_c[@]}" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 || rc=$?
      if [ "$BRANCH_GIVEN" = 1 ] && [ "$branch" != "$BRANCH" ]; then
        info "Switching to the branch $BRANCH."
        "${git_c[@]}" fetch -q origin "$BRANCH" || fail "There is no branch $BRANCH on GitHub."
        "${git_c[@]}" checkout -q -B "$BRANCH" --track "origin/$BRANCH" || fail "Switching didn’t work – see above."
      elif [ "$branch" != main ] && [ "$rc" = 2 ]; then
        # 2 = den Branch gibt es nicht mehr (z. B. nach dem Merge gelöscht)
        info "The branch $branch is gone on GitHub (merged?) – switching to main."
        "${git_c[@]}" fetch -q origin main || fail "git fetch didn’t work – see above."
        "${git_c[@]}" checkout -q -B main --track origin/main || fail "Switching to main didn’t work – see above."
      fi
      "${git_c[@]}" pull --ff-only || fail "git pull didn’t work – see above."
      # Mit dem neuen Installer weitermachen
      exec env OYS_PULLED=1 bash "$CODE/server/install.sh" --update
    fi
    step_packages
    load_db_pass
    [ -n "$DB_PASS" ] || fail "config.php has no database password – run the installer without --update."
    step_website
    bold "6/8  Protection, backups and weekly report"
    step_protect
    write_timers
    save_conf
    step_bot
    bold "Checking the website"
    check_site
    bold "Done."
    ;;
  https)
    [ -f "$CONF" ] || fail "OnYourSite isn’t set up on this server yet. Run: ${SUDO_HINT}bash $CODE/server/install.sh"
    DOMAIN=$(conf_get DOMAIN)
    PHPV=$(conf_get PHP_VERSION)
    ensure_cert
    step_https force
    write_timers
    ;;
esac
exit 0
}
