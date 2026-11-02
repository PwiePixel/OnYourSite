# shellcheck shell=bash disable=SC2153,SC2034
# OnYourSite – Statusseiten: Dienste auf dem eigenen Server (Prüfdienst und Sensor). Diese Datei lädt server/install.sh
# mit „. "$CODE/server/status-units.sh"“ (server/backup.sh für status_backup_dump und status_ping) – beim Laden passiert
# nichts, sie definiert nur Funktionen und zwei Werte.
#
# Erwartet von install.sh: CODE, NODE, WEB, UNITS, CONFIG_MJS, TUNNEL (yes|no), PORT (Port der Webseite) und die
# Funktionen write_if_changed, info, warn.
#
#   write_status_units [update]   config.json → status schreiben, die Units schreiben, daemon-reload, enable --now,
#                                 den Schutz im Kernel testen; mit „update“ den Prüfdienst neu starten (neuer Code).
#                                 Aufruf in jedem Modus, der die Topologie ändern kann: Einrichtung (step_services),
#                                 --update, --https und --tunnel.
#   status_units_stop             vor DROP DATABASE (--reset): alle Status-Units anhalten
#   status_units_disable          beim Entfernen: anhalten und abschalten
#   status_planned SEKUNDEN       geplantes Fenster: vor dem Neustart von Webseite/Tunnel 600, nach check_site 0
#   status_buffer_pool_line       Zeile „innodb_buffer_pool_size = …“ für 90-onyoursite.cnf (oder nichts)
#   status_backup_dump DB         mysqldump für backup.sh: alles, von status_checks nur die Tabelle (ohne Daten)
#   status_ping JOB               Heartbeat (backup | weekly) – letzte Zeile von backup.sh
#   status_summary_line           Zeile für summary()
#   STATUS_TUNNEL_METRICS         für die Tunnel-Unit: Environment=TUNNEL_METRICS=$STATUS_TUNNEL_METRICS (fester Port,
#                                 den der Sensor auf /ready abfragt)

STATUS_TUNNEL_METRICS=127.0.0.1:20241
STATUS_UNITS="onyoursite-status.service onyoursite-status-local.timer onyoursite-status-local.service onyoursite-status-notify.service"

# Alle globalen Adressen des Servers (IPv4 und IPv6, ohne Präfix) – nicht nur die erste wie ip4()/ip6()
status_self_ips() {
  ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -E '^[0-9a-fA-F:.]+$' | sort -u | paste -sd' ' - || true
}

# config.json → status: Server-Fakten (Tunnel, eigene Adressen). Von Hand geänderte Resolver und Kanarienvögel bleiben.
status_config_block() {
  local self=$1 kernel=${2:-} file=$CODE/config.json block
  block=$(OYS_SELF="$self" OYS_TUNNEL="$TUNNEL" OYS_KERNEL="$kernel" "$NODE" -e '
    const fs = require("fs");
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).status || {}; } catch {}
    if (typeof cur !== "object" || Array.isArray(cur) || cur === null) cur = {};
    const list = (v, d) => Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? v : d;
    const ips = (process.env.OYS_SELF || "").split(" ").filter(Boolean);
    const kernel = process.env.OYS_KERNEL;
    const out = {
      tunnel: process.env.OYS_TUNNEL === "yes",
      self_ips: ips,
      egress_ips: ips,
      dns: list(cur.dns, ["1.1.1.1", "1.0.0.1", "9.9.9.9"]),
      canaries: list(cur.canaries, ["https://www.gstatic.com/generate_204", "https://www.cloudflare.com/cdn-cgi/trace", "https://detectportal.firefox.com/success.txt"]),
      concurrency: Number.isInteger(cur.concurrency) ? cur.concurrency : 1000,
      keyword_concurrency: Number.isInteger(cur.keyword_concurrency) ? cur.keyword_concurrency : 64,
      user_inflight: Number.isInteger(cur.user_inflight) ? cur.user_inflight : 32,
      kernel_guard: kernel === "yes" ? true : kernel === "no" ? false : (typeof cur.kernel_guard === "boolean" ? cur.kernel_guard : null),
    };
    process.stdout.write(JSON.stringify(out));
  ' "$file") || return 1
  OYS_VALUE=$block "$NODE" "$CONFIG_MJS" set status --json --file "$file"
}

# Gilt IPAddressDeny auf diesem Server? Ohne cgroup-BPF (manche Container-Server) ignoriert systemd es still.
# Erst ohne Sperre (muss klappen – sonst ist nichts prüfbar), dann mit: klappt es dann immer noch, wirkt sie nicht.
# Ausgabe: yes (wirkt), no (wirkt nicht) oder nichts (nicht prüfbar, z. B. die Webseite antwortet gerade nicht)
status_kernel_guard_test() {
  local url="http://127.0.0.1:$PORT/_/health"
  command -v systemd-run >/dev/null 2>&1 || return 0
  if ! systemd-run --wait --pipe --quiet -p User="$WEB" curl -s --noproxy '*' -o /dev/null --max-time 3 "$url" >/dev/null 2>&1; then
    return 0
  fi
  if systemd-run --wait --pipe --quiet -p User="$WEB" -p IPAddressDeny=localhost \
      curl -s --noproxy '*' -o /dev/null --max-time 3 "$url" >/dev/null 2>&1; then
    echo no
  else
    echo yes
  fi
}

write_status_units() {
  local mode=${1:-} host self deny="" kernel
  host=$("$NODE" "$CONFIG_MJS" get db.host --file "$CODE/config.json" 2>/dev/null || true)
  if [ -n "$host" ] && [ "$host" != localhost ]; then
    warn "The status checker needs the database socket: set db.host to localhost. The status services were not set up."
    return 1
  fi
  self=$(status_self_ips)
  # Mit dem Tunnel führen die eigenen Adressen am Tunnel vorbei – der Prüfdienst darf sie nie erreichen
  if [ "$TUNNEL" = yes ]; then deny=" $self"; fi
  status_config_block "$self" || { warn "config.json couldn’t be updated for the status services."; return 1; }

  write_if_changed "$UNITS/onyoursite-status.service" <<EOF || true
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite status checks (monitors, incidents)
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
Type=simple
User=$WEB
Group=$WEB
WorkingDirectory=$CODE/app
Environment=NODE_ENV=production
Environment=UV_THREADPOOL_SIZE=8
Environment=OYS_DB_POOL_SIZE=4
ExecStart=$NODE --max-old-space-size=384 $CODE/app/dist/status/worker.js
Restart=always
RestartSec=5
TimeoutStopSec=20
# Only the internet and the database socket – never this server, its network or a metadata service (second layer against SSRF).
# No IPAddressAllow: it would open whole addresses on every port and it wins over IPAddressDeny.
IPAddressDeny=localhost link-local multicast 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 168.63.129.16/32 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 240.0.0.0/4 ::/128 ::ffff:0:0/96 64:ff9b::/96 2002::/16 fc00::/7 fec0::/10$deny
# AF_NETLINK only lists this server's own addresses (os.networkInterfaces); it reaches no other host.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
# The checks may use at most 2 CPUs
CPUQuota=200%
MemoryMax=768M
TasksMax=64
LimitNOFILE=16384
Nice=5

[Install]
WantedBy=multi-user.target
EOF

  write_if_changed "$UNITS/onyoursite-status-local.service" <<EOF || true
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite status: local probes (tunnel, web server, disk, mail) and watchdog
After=mariadb.service

[Service]
Type=oneshot
User=$WEB
Group=$WEB
WorkingDirectory=$CODE/app
Environment=NODE_ENV=production
Environment=OYS_DB_POOL_SIZE=2
ExecStart=$NODE $CODE/app/dist/status/local.js
StateDirectory=onyoursite-status
StateDirectoryMode=0700
TimeoutStartSec=50
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=192M
EOF

  write_if_changed "$UNITS/onyoursite-status-local.timer" <<EOF || true
# OnYourSite – written by server/install.sh
[Unit]
Description=OnYourSite status probes every minute

[Timer]
OnBootSec=90s
OnUnitActiveSec=60s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now onyoursite-status.service onyoursite-status-local.timer >/dev/null 2>&1 || warn "The status services couldn’t be started – see: journalctl -u onyoursite-status"
  if [ "$mode" = update ]; then systemctl restart onyoursite-status.service >/dev/null 2>&1 || true; fi

  kernel=$(status_kernel_guard_test)
  if [ "$kernel" = no ]; then
    warn "This server ignores IPAddressDeny – status checks rely on the app guard only."
  elif [ -z "$kernel" ]; then
    info "The kernel guard for status checks couldn’t be tested right now (the website didn’t answer)."
  fi
  if [ -n "$kernel" ]; then status_config_block "$self" "$kernel" || true; fi
  return 0
}

status_units_stop() {
  # shellcheck disable=SC2086
  systemctl stop $STATUS_UNITS >/dev/null 2>&1 || true
}

status_units_disable() {
  # shellcheck disable=SC2086
  systemctl disable --now $STATUS_UNITS >/dev/null 2>&1 || true
}

status_planned() {
  runuser -u "$WEB" -- env NODE_ENV=production "$NODE" "$CODE/app/dist/status/ctl.js" planned "$1" >/dev/null 2>&1 || true
}

# MariaDB: ein Viertel des Arbeitsspeichers für den Puffer (512 MB bis 16 GB) – außer der Admin hat es woanders gesetzt
status_buffer_pool_line() {
  local kb mb meminfo=${STATUS_MEMINFO:-/proc/meminfo} conf_dir=${STATUS_MYSQL_CONF:-/etc/mysql}
  if grep -rlsE '^[[:space:]]*innodb[_-]buffer[_-]pool[_-]size' "$conf_dir" 2>/dev/null | grep -qv '90-onyoursite.cnf$'; then return 0; fi
  kb=$(awk '/^MemTotal:/ {print $2}' "$meminfo" 2>/dev/null)
  [[ $kb =~ ^[0-9]+$ ]] || return 0
  mb=$((kb / 1024 / 4))
  if [ "$mb" -lt 512 ]; then mb=512; fi
  if [ "$mb" -gt 16384 ]; then mb=16384; fi
  echo "innodb_buffer_pool_size = ${mb}M"
}

# Für backup.sh: einzelne Prüfungen sind kurzlebig und groß – von status_checks nur die Tabelle (die Partitionen
# ordnet der Prüfdienst beim Start neu)
status_backup_dump() {
  local db=$1
  local opts=(--single-transaction --quick --routines --default-character-set=utf8mb4)
  if mariadb -N -e "SHOW TABLES LIKE 'status\\_checks'" "$db" 2>/dev/null | grep -q .; then
    mysqldump "${opts[@]}" --ignore-table="$db.status_checks" "$db"
    mysqldump --single-transaction --no-data --default-character-set=utf8mb4 "$db" status_checks
  else
    mysqldump "${opts[@]}" "$db"
  fi
}

# Heartbeat eines Jobs (Fehler zählen nicht – die Sicherung ist trotzdem fertig)
status_ping() {
  local node=${NODE:-} web=${WEB:-www-data}
  if [ -z "$node" ] && [ -f /etc/onyoursite/server.conf ]; then node=$(sed -n 's/^NODE=//p' /etc/onyoursite/server.conf | tail -n 1); fi
  if [ -z "$node" ] || [ ! -x "$node" ] || [ ! -f "$CODE/app/dist/status/ctl.js" ]; then return 0; fi
  runuser -u "$web" -- env NODE_ENV=production "$node" "$CODE/app/dist/status/ctl.js" ping "$1" >/dev/null 2>&1 || true
}

status_summary_line() {
  echo "Status page: https://status.$1 · checks: systemctl status onyoursite-status onyoursite-status-local.timer"
}
