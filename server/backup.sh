#!/usr/bin/env bash
# OnYourSite – nächtliche Sicherung (systemd-Timer „onyoursite-backup“, eingerichtet von server/install.sh).
# Sichert Datenbank, Uploads, config.php, email/ und die Bot-Einstellungen nach /var/backups/onyoursite/<Datum>/.
# Die Uploads sind Schnappschüsse mit festen Verknüpfungen: unveränderte Dateien belegen nur einmal Platz.
# Von Hand: sudo systemctl start onyoursite-backup  ·  mit eigenem Namen: sudo bash server/backup.sh before-reset
set -euo pipefail
umask 077

CONF=/etc/onyoursite/server.conf
DEST=/var/backups/onyoursite
UPLOADS=/var/lib/onyoursite/uploads
DB=onyoursite

get() { sed -n "s/^$1=//p" "$CONF" | tail -n 1; }
CODE=$(get CODE)
KEEP=$(get BACKUP_DAYS)
KEEP=${KEEP:-14}
[ -f "$CODE/config.php" ] || { echo "Backup: no config.php in '$CODE'." >&2; exit 1; }

# Optional ein Zusatz im Ordnernamen, z. B. „before-reset“ – dann mit Uhrzeit: so überschreibt weder die nächtliche
# Sicherung noch ein zweiter Neuanfang am selben Tag diese Sicherung
label=${1:-}
[[ $label =~ ^[a-z0-9-]*$ ]] || { echo "Backup: invalid name '$label'." >&2; exit 1; }
if [ -n "$label" ]; then dir=$DEST/$(date +%F-%H%M%S)-$label; else dir=$DEST/$(date +%F); fi
mkdir -p "$dir"
chmod 700 "$DEST"

mysqldump --single-transaction --quick --routines --default-character-set=utf8mb4 "$DB" | gzip > "$dir/database.sql.gz.part"
mv "$dir/database.sql.gz.part" "$dir/database.sql.gz"

link=()
if [ -d "$DEST/latest/uploads" ] && [ "$(readlink -f "$DEST/latest")" != "$(readlink -f "$dir")" ]; then
  link=(--link-dest="$DEST/latest/uploads")
fi
rsync -a --delete "${link[@]}" "$UPLOADS/" "$dir/uploads/"

settings=(-C "$CODE" config.php email)
if [ -f /etc/onyoursite-bot.env ]; then settings+=(-C /etc onyoursite-bot.env); fi
tar -czf "$dir/settings.tar.gz" "${settings[@]}"

ln -sfn "$dir" "$DEST/latest"
find "$DEST" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$KEEP" -exec rm -rf {} +
echo "Backup saved: $dir ($(du -sh "$dir" | cut -f1))"
