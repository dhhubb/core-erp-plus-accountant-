#!/usr/bin/env bash
#
# Branch HTTPS on the LAN.
#
# A branch till is served over HTTPS on the shop LAN, because a PWA install and IndexedDB in a
# secure context need it, and because `next start` on plain HTTP is fine for a desktop browser but
# not for an installed app. This script issues a self-signed certificate for the branch's LAN host
# and prints the two environment variables `next start` reads to serve TLS.
#
# The certificate is self-signed: it is trusted only after it is installed on the tills. For a real
# deployment, replace it with a certificate from the organisation's CA. The script never touches a
# system trust store.
#
# Usage:
#   scripts/branch-https.sh [HOST] [OUT_DIR]
#     HOST     the branch host name or IP the tills will use (default: the machine's first LAN IP)
#     OUT_DIR  where to write the certificate (default: certs/)
#
# Then start the branch server with:
#   BRANCH_MODE=branch HTTPS=1 TLS_CERT_FILE=certs/branch.crt TLS_KEY_FILE=certs/branch.key npm run start

set -euo pipefail

HOST="${1:-}"
OUT_DIR="${2:-certs}"

if [ -z "$HOST" ]; then
  # The first non-loopback IPv4 address, which is the address a till on the LAN will reach.
  HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$HOST" ]; then
  echo "Could not determine a LAN host; pass one explicitly: scripts/branch-https.sh 192.168.1.10" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
KEY="$OUT_DIR/branch.key"
CRT="$OUT_DIR/branch.crt"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" -out "$CRT" -days 825 \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=DNS:$HOST,IP:$HOST" >/dev/null 2>&1

chmod 600 "$KEY"

echo "Issued a self-signed certificate for $HOST:"
echo "  key: $KEY"
echo "  crt: $CRT"
echo
echo "Start the branch server with TLS:"
echo "  BRANCH_MODE=branch TLS_CERT_FILE=$CRT TLS_KEY_FILE=$KEY npm run start:branch"
echo
echo "Install $CRT on each till (or issue one from your CA) so the browser trusts it."
