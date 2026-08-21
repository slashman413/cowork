#!/bin/bash
# Generate a self-signed TLS cert/key so the cowork dashboard can be served over
# https:// — required for the New-task "Dictate" mic button to work on anything
# other than localhost (browsers only expose the microphone API in a "secure
# context": https:// or localhost).
#
# Usage:
#   ./gen-tls-cert.sh [output-dir] [common-name] [extra-SAN ...]
#
# Examples:
#   ./gen-tls-cert.sh                       # -> ~/.cowork/tls/{cert,key}.pem, CN=localhost
#   ./gen-tls-cert.sh ~/.cowork/tls cowork-host 100.80.243.33 cowork.tail1234.ts.net
#
# Then point ~/.cowork/config.json at the files and restart cowork-mcp:
#   "server": {
#     ...,
#     "tls": { "certFile": "~/.cowork/tls/cert.pem", "keyFile": "~/.cowork/tls/key.pem" }
#   }
#
# A self-signed cert triggers a one-time browser warning ("Proceed to site").
# That's expected — once you proceed, the origin is a secure context and the mic
# works. For a warning-free cert on a Tailscale tailnet, prefer `tailscale serve`
# (real Let's Encrypt cert) instead of this script.
set -euo pipefail

OUT_DIR="${1:-$HOME/.cowork/tls}"
CN="${2:-localhost}"
shift || true
shift || true

mkdir -p "$OUT_DIR"

# Build subjectAltName from CN + any extra hostnames/IPs passed as args.
SAN="DNS:${CN}"
[ "$CN" != "localhost" ] && SAN="${SAN},DNS:localhost"
SAN="${SAN},IP:127.0.0.1"
for host in "$@"; do
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    SAN="${SAN},IP:${host}"
  else
    SAN="${SAN},DNS:${host}"
  fi
done

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -days 3650 \
  -subj "/CN=${CN}" \
  -addext "subjectAltName=${SAN}"

chmod 600 "$OUT_DIR/key.pem"

echo
echo "Wrote:"
echo "  $OUT_DIR/cert.pem"
echo "  $OUT_DIR/key.pem"
echo "SAN: ${SAN}"
echo
echo "Add to ~/.cowork/config.json under \"server\":"
echo "  \"tls\": { \"certFile\": \"$OUT_DIR/cert.pem\", \"keyFile\": \"$OUT_DIR/key.pem\" }"
echo "then restart: systemctl --user restart cowork-mcp.service"
