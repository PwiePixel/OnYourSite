#!/usr/bin/env bash
# Neue Version vorbereiten: scripts/release.sh 3.2.0
# Verschiebt die Einträge unter [Unreleased] in CHANGELOG.md in einen Abschnitt für diese Version (mit heutigem
# Datum) und schreibt die Nummer in VERSION, app/package.json und app/package-lock.json. Danach committen und nach
# main bringen – GitHub legt Tag und Release dann automatisch an (.github/workflows/release.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:-}"
current="$(tr -d '[:space:]' < VERSION)"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/release.sh X.Y.Z   (current version: $current)" >&2
  exit 1
fi
if [ "$version" = "$current" ] || [ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n 1)" != "$version" ]; then
  echo "$version must be higher than the current version $current." >&2
  exit 1
fi
if grep -q "^## \[$version\]" CHANGELOG.md; then
  echo "CHANGELOG.md already has a section for $version." >&2
  exit 1
fi
# Steht unter [Unreleased] überhaupt etwas?
if ! awk '/^## \[Unreleased\]/ { f = 1; next } /^## \[/ { f = 0 } f && /[^[:space:]]/ { found = 1 } END { exit !found }' CHANGELOG.md; then
  echo "Nothing under [Unreleased] in CHANGELOG.md – describe the changes there first." >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "Node.js is needed to update app/package.json." >&2; exit 1; }

today="$(date +%Y-%m-%d)"
awk -v v="$version" -v d="$today" '
  /^## \[Unreleased\]/ { print; print ""; print "## [" v "] - " d; next }
  { print }
' CHANGELOG.md > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md
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
echo "Prepared $version: check CHANGELOG.md, commit it (e.g. \"Release $version\") and merge it into main."
