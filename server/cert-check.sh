#!/usr/bin/env bash
# Läuft nach der täglichen Zertifikats-Erneuerung (Timer onyoursite-certs, eingerichtet von server/install.sh).
# acme.sh erneuert das Zertifikat rund 30 Tage vor dem Ablauf. Gilt es nur noch weniger als 14 Tage, hat das
# nicht geklappt – dann bekommen alle Admins eine Mail über den Mailserver der Webseite.
set -euo pipefail
CERT=/etc/ssl/onyoursite/fullchain.pem
CODE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)

end=$(date -d "$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)" +%s)
days=$(( (end - $(date +%s)) / 86400 ))
if [ "$days" -ge 14 ]; then
  echo "The HTTPS certificate is valid for $days more days."
  exit 0
fi
echo "The HTTPS certificate expires in $days days – the automatic renewal didn’t work." >&2
runuser -u www-data -- php "$CODE/server/cert-alert.php" "$days" || true
exit 1
