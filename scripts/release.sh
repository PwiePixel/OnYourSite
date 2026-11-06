#!/usr/bin/env bash
# Neue Version vorbereiten – zwei Kanäle:
#   scripts/release.sh 3.6.0          Release für alle: verschiebt die Einträge unter [Unreleased] in CHANGELOG.md in
#                                     einen Abschnitt für diese Version (mit heutigem Datum) und entfernt die Abschnitte
#                                     ihrer Pre-Releases (3.6.0-beta.N). Danach committen und nach main bringen.
#   scripts/release.sh 3.6.0-beta.1   Pre-Release nur für die Beta-Webseite (beta.<domain>): kopiert die Einträge unter
#                                     [Unreleased] in einen Abschnitt 3.6.0-beta.1 – [Unreleased] bleibt, bis 3.6.0
#                                     erscheint. Danach committen und auf den Branch beta bringen.
# Beide schreiben die Nummer in VERSION, app/package.json und app/package-lock.json. GitHub legt Tag und Release dann
# automatisch an (.github/workflows/release.yml) – vom Branch beta als Pre-Release.
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:-}"
current="$(tr -d '[:space:]' < VERSION)"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[1-9][0-9]*)?$ ]]; then
  echo "Usage: scripts/release.sh X.Y.Z (a release) or X.Y.Z-beta.N (a pre-release)   (current version: $current)" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "Node.js is needed to compare versions and update app/package.json." >&2; exit 1; }
# Höher als die aktuelle? Wie SemVer: 3.6.0-beta.1 < 3.6.0-beta.2 < 3.6.0
higher="$(node -e '
  const key = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(v); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : [0, 0, 0, 0]; };
  const a = key(process.argv[1]), b = key(process.argv[2]);
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) { console.log(a[i] > b[i] ? "yes" : "no"); process.exit(0); }
  console.log("no");' "$version" "$current")"
if [ "$higher" != yes ]; then
  echo "$version must be higher than the current version $current." >&2
  exit 1
fi
base="${version%%-*}"
pre=0
[ "$base" != "$version" ] && pre=1
if grep -q "^## \[$version\]" CHANGELOG.md; then
  echo "CHANGELOG.md already has a section for $version." >&2
  exit 1
fi
# Steht unter [Unreleased] überhaupt etwas?
if ! awk '/^## \[Unreleased\]/ { f = 1; next } /^## \[/ { f = 0 } f && /[^[:space:]]/ { found = 1 } END { exit !found }' CHANGELOG.md; then
  echo "Nothing under [Unreleased] in CHANGELOG.md – describe the changes there first." >&2
  exit 1
fi
today="$(date +%Y-%m-%d)"
if [ "$pre" = 1 ]; then
  # Pre-Release: die Einträge unter [Unreleased] kopieren – sie bleiben dort für das Release
  awk -v v="$version" -v d="$today" '
    /^## \[Unreleased\]/ { f = 1; print; next }
    f && /^## \[/ { f = 0; out(); }
    f { buf[++n] = $0; print; next }
    { print }
    END { if (f) out() }
    function out(  s, e, i) {
      s = 1; while (s <= n && buf[s] ~ /^[[:space:]]*$/) s++
      e = n; while (e >= s && buf[e] ~ /^[[:space:]]*$/) e--
      print "## [" v "] - " d; print ""
      for (i = s; i <= e; i++) print buf[i]
      print ""
      n = 0
    }
  ' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
else
  # Release: die Abschnitte seiner Pre-Releases fallen weg, [Unreleased] wird zu dieser Version
  awk -v v="$version" -v d="$today" '
    index($0, "## [" v "-beta.") == 1 { skip = 1; next }
    skip && /^## \[/ { skip = 0 }
    skip { next }
    /^## \[Unreleased\]/ { print; print ""; print "## [" v "] - " d; next }
    { print }
  ' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
fi
printf '%s\n' "$version" > VERSION
# Gleiche Nummer im Paket der Website (ohne npm: nur das Feld version wird ersetzt)
node -e '
  const fs = require("fs");
  for (const f of ["app/package.json", "app/package-lock.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = process.argv[1];
    if (j.packages && j.packages[""]) j.packages[""].version = process.argv[1];
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }' "$version"
if ! grep -q "version: '$base'" app/src/updates/releaseNotes.ts; then
  echo "Now write the text for /updates: add an entry for '$base' to app/src/updates/releaseNotes.ts (the tests check it)."
fi
if [ "$pre" = 1 ]; then
  echo "Prepared the pre-release $version: check CHANGELOG.md, commit it (e.g. \"Pre-release $version\") and bring it to the branch beta."
  echo "Then on the server: sudo bash /var/www/onyoursite/server/install.sh --beta"
else
  echo "Prepared $version: check CHANGELOG.md, commit it (e.g. \"Release $version\") and merge it into main."
fi
