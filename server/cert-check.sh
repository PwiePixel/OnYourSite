#!/usr/bin/env bash
# Läuft nach der täglichen Zertifikats-Erneuerung (Timer onyoursite-certs, eingerichtet von server/install.sh).
# acme.sh erneuert das Zertifikat rund 30 Tage vor dem Ablauf. Gilt es nur noch weniger als 14 Tage, hat das
# nicht geklappt – dann bekommen alle Admins eine Mail über den Mailserver der Webseite (node app/dist/cli.js cert-alert).
set -euo pipefail
CERT=/etc/ssl/onyoursite/fullchain.pem
CODE=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
# Node.js wie beim Einrichten (server.conf), sonst das im Suchpfad
NODE=$(sed -n 's/^NODE=//p' /etc/onyoursite/server.conf 2>/dev/null | tail -n 1)
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then NODE=$(command -v node || true); fi

end=$(date -d "$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)" +%s)
days=$(( (end - $(date +%s)) / 86400 ))
if [ "$days" -ge 14 ]; then
  echo "The HTTPS certificate is valid for $days more days."
  exit 0
fi
echo "The HTTPS certificate expires in $days days – the automatic renewal didn’t work." >&2
if [ -n "$NODE" ]; then
  runuser -u www-data -- "$NODE" "$CODE/app/dist/cli.js" cert-alert "$days" || true
else
  echo "Node.js is missing – no warning sent." >&2
fi
exit 1
