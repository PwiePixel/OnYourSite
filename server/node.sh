# shellcheck shell=bash
# OnYourSite – gemeinsame Node.js-Installation für die Webseite (server/install.sh) und den Discord-Bot
# (discord-bot/install.sh). Node.js 22 kommt aus der Paketquelle von NodeSource (deb.nodesource.com, setup_22.x).
# Wird mit „.“ eingebunden, nicht ausgeführt:
#
#   . server/node.sh
#   node_find 22        Pfad eines node ab Version 22 (oder nichts, Rückgabe 1) – auch node_find 18 17 für „ab 18.17“
#   node_install        Node.js 22 von NodeSource installieren (ersetzt ein älteres nodejs-Paket); Ausgabe nur bei Fehlern
#   node_ensure 22      node_find, sonst node_install – setzt NODE (Pfad zu node) und NODE_BIN (Ordner mit node und npm)
#
# Ein node ab der verlangten Version bleibt, wie es ist (auch ein neueres); installiert wird immer Version 22.
NODE_MAJOR=22

# Passt die Version von node unter PFAD? node_version_ok PFAD HAUPTVERSION [NEBENVERSION]
node_version_ok() {
  "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); const [x, y] = process.argv.slice(1).map(Number);
    process.exit(a > x || (a === x && b >= y) ? 0 : 1)' "$2" "${3:-0}" 2>/dev/null
}

# Erstes passendes node: im Suchpfad, dann /usr/bin und /usr/local/bin
node_find() {
  local c
  for c in "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/local/bin/node; do
    if [ -n "$c" ] && [ -x "$c" ] && node_version_ok "$c" "${1:-$NODE_MAJOR}" "${2:-0}"; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# Node.js 22 von NodeSource – die Ausgabe kommt in eine Datei und wird nur bei einem Fehler gezeigt
node_install() {
  local log rc=0
  if ! command -v curl >/dev/null 2>&1; then
    printf '  %s\n' "curl is missing – install it first (apt install curl)." >&2
    return 1
  fi
  log=$(mktemp)
  { curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; } >"$log" 2>&1 || rc=$?
  if [ "$rc" = 0 ]; then
    apt-get -o DPkg::Lock::Timeout=600 install -y -qq nodejs >>"$log" 2>&1 || rc=$?
  fi
  if [ "$rc" != 0 ]; then
    tail -n 25 "$log" | grep -v "stable CLI interface" | sed 's/^/    /' >&2
  fi
  rm -f "$log"
  return "$rc"
}

# NODE und NODE_BIN setzen; fehlt ein passendes Node.js, wird Version 22 installiert
node_ensure() {
  NODE=$(node_find "$@") || { node_install && NODE=$(node_find "$@"); } || return 1
  NODE_BIN=$(dirname "$NODE")
  [ -x "$NODE_BIN/npm" ] || command -v npm >/dev/null 2>&1
}
