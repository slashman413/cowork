#!/bin/bash
# Fetch or renew a trusted Let's Encrypt TLS cert via Tailscale and install it
# to ~/.cowork/tls/cert.pem and ~/.cowork/tls/key.pem for the cowork server.
#
# Usage:
#   deploy/update-tailscale-cert.sh [dest-dir]
#
# Default dest-dir is ~/.cowork/tls.
set -euo pipefail

DEST_DIR="${1:-$HOME/.cowork/tls}"
mkdir -p "$DEST_DIR"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Error: tailscale CLI not found" >&2
  exit 1
fi

DOMAIN="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')"
if [ -z "$DOMAIN" ]; then
  echo "Error: could not determine Tailscale DNS name (is Tailscale connected?)" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Fetching Let's Encrypt TLS certificate for $DOMAIN via Tailscale..."
tailscale cert --cert-file "$TMP_DIR/cert.pem" --key-file "$TMP_DIR/key.pem" "$DOMAIN"

# Backup existing certificates if present
[ -f "$DEST_DIR/cert.pem" ] && cp -f "$DEST_DIR/cert.pem" "$DEST_DIR/cert.pem.bak"
[ -f "$DEST_DIR/key.pem" ] && cp -f "$DEST_DIR/key.pem" "$DEST_DIR/key.pem.bak"

cp -f "$TMP_DIR/cert.pem" "$DEST_DIR/cert.pem"
cp -f "$TMP_DIR/key.pem" "$DEST_DIR/key.pem"
chmod 600 "$DEST_DIR/cert.pem" "$DEST_DIR/key.pem"

# Also ensure localhost fallback cert exists in DEST_DIR for local SNI fallback
if [ ! -f "$DEST_DIR/localhost.pem" ] || [ ! -f "$DEST_DIR/localhost-key.pem" ]; then
  echo "Generating local fallback certificate for localhost/127.0.0.1..."
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$DEST_DIR/localhost-key.pem" \
    -out "$DEST_DIR/localhost.pem" \
    -days 3650 \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" >/dev/null 2>&1 || true
  chmod 600 "$DEST_DIR/localhost.pem" "$DEST_DIR/localhost-key.pem" 2>/dev/null || true
fi

echo "Successfully installed Let's Encrypt TLS certificate to:"
echo "  $DEST_DIR/cert.pem"
echo "  $DEST_DIR/key.pem"
echo "Domain: $DOMAIN"
echo
echo "Cowork Web Server Access URLs:"
echo "  • Trusted HTTPS (Chrome / Mobile / Remote): https://$DOMAIN:6868/"
echo "  • Local Machine (Secure Context in Chrome):   http://localhost:6868/"
echo
echo "Note: Chrome natively treats http://localhost as a Secure Context (window.isSecureContext=true)"
echo "with zero SSL warnings. For remote or mobile access, use the trusted HTTPS URL above."
