#!/usr/bin/env bash
# Läuft auf GitHub (Workflow "Release"): legt für jede Version aus CHANGELOG.md, die noch kein
# GitHub-Release hat, eines an – mit den Notizen aus CHANGELOG.md und dem Quellcode als ZIP.
# Die aktuelle Version (VERSION) bekommt ihr Tag auf dem aktuellen Commit; ältere Versionen nur,
# wenn ihr Tag schon existiert.
# Zwei Kanäle (GITHUB_REF_NAME): main veröffentlicht Releases (X.Y.Z, das neueste als „Latest“); beta nur das aktuelle
# Pre-Release (X.Y.Z-beta.N, auf GitHub als Pre-Release markiert, nie „Latest“) – es läuft auf der Beta-Webseite.
set -euo pipefail
cd "$(dirname "$0")/.."

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
sha="${GITHUB_SHA:-$(git rev-parse HEAD)}"
current="$(tr -d '[:space:]' < VERSION)"
channel="${GITHUB_REF_NAME:-main}"
is_pre() { [[ "$1" == *-* ]]; }
if [ "$channel" = main ] && is_pre "$current"; then
  echo "::error file=VERSION::main needs a release version – $current is a pre-release (scripts/release.sh X.Y.Z)."
  exit 1
fi

# Text eines Abschnitts aus CHANGELOG.md, ohne Überschrift und ohne Leerzeilen am Anfang und Ende
section() {
  awk -v v="$1" '
    index($0, "## [" v "]") == 1 { f = 1; next }
    /^## \[/ { f = 0 }
    f { lines[++n] = $0 }
    END {
      s = 1; while (s <= n && lines[s] ~ /^[[:space:]]*$/) s++
      e = n; while (e >= s && lines[e] ~ /^[[:space:]]*$/) e--
      for (i = s; i <= e; i++) print lines[i]
    }' CHANGELOG.md
}

versions="$(grep -oE '^## \[[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?\]' CHANGELOG.md | tr -d '#[] ' | sort -V)"
if ! printf '%s\n' "$versions" | grep -qx "$current"; then
  echo "::error file=CHANGELOG.md::CHANGELOG.md has no section for version $current (from VERSION)."
  exit 1
fi
# „Latest“ ist immer das neueste Release, nie ein Pre-Release
newest="$(printf '%s\n' "$versions" | grep -v -- '-' | tail -n 1 || true)"
work="$(mktemp -d)"
prev=""

for v in $versions; do
  tag="v$v"
  # beta: nur das aktuelle Pre-Release; main: keine Pre-Releases (die erschienen vom Branch beta)
  if [ "$channel" != main ]; then
    if [ "$v" != "$current" ] || ! is_pre "$v"; then continue; fi
  elif is_pre "$v"; then
    continue
  fi
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    prev="$tag"
    continue
  fi
  target=""
  if ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    if [ "$v" != "$current" ]; then
      echo "::notice::$tag has no tag yet – skipped. Tag the commit of that version to publish it."
      continue
    fi
    target="$sha"
  fi

  notes="$work/$tag.md"
  section "$v" > "$notes"
  if [ ! -s "$notes" ]; then
    echo "::error file=CHANGELOG.md::The section for $v is empty."
    exit 1
  fi
  if is_pre "$v"; then
    printf '> **Pre-release** – only on the beta website for beta testers. Everyone gets it with OnYourSite %s.\n\n' "${v%%-*}" | cat - "$notes" > "$notes.tmp" && mv "$notes.tmp" "$notes"
  fi
  if [ -n "$prev" ]; then
    printf '\n**Full changelog:** https://github.com/%s/compare/%s...%s\n' "$repo" "$prev" "$tag" >> "$notes"
  fi

  # Quellcode als ZIP (ohne Tests und Entwicklungsdateien, siehe .gitattributes); installiert wird mit server/install.sh
  zip="$work/OnYourSite-$tag.zip"
  git archive --worktree-attributes --format=zip --prefix="OnYourSite-$tag/" -o "$zip" "${target:-$tag}"

  latest=false
  [ "$v" = "$newest" ] && latest=true
  prerelease=()
  if is_pre "$v"; then prerelease=(--prerelease); fi
  gh release create "$tag" "$zip" --repo "$repo" --title "OnYourSite $v" --notes-file "$notes" \
    ${target:+--target "$target"} --latest="$latest" "${prerelease[@]}"
  echo "Published $tag"
  prev="$tag"
done
