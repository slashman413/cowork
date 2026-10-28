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

echo "Successfully installed Let's Encrypt TLS certificate to:"
echo "  $DEST_DIR/cert.pem"
echo "  $DEST_DIR/key.pem"
echo "Domain: $DOMAIN"
