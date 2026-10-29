#!/usr/bin/env bash
set -euo pipefail

# sync-pstack.sh — Vendor a pinned copy of pstack skills + LICENSE at a given commit.
# Usage: ./scripts/sync-pstack.sh [commit-sha] (defaults to 0c3333f)

SHA="${1:-0c3333f}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${REPO_ROOT}/vendor/pstack"
TMP_DIR="$(mktemp -d /tmp/pstack-sync.XXXXXX)"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "Syncing pstack at commit ${SHA}..."
if [ -d "/tmp/pstack/.git" ]; then
  # Fast path if local cache exists
  git clone --no-checkout /tmp/pstack "${TMP_DIR}"
  git -C "${TMP_DIR}" checkout "${SHA}"
else
  git clone https://github.com/backnotprop/pstack "${TMP_DIR}"
  git -C "${TMP_DIR}" checkout "${SHA}"
fi

mkdir -p "${TARGET_DIR}"
rm -rf "${TARGET_DIR}/skills" "${TARGET_DIR}/LICENSE"
cp -r "${TMP_DIR}/skills" "${TARGET_DIR}/"
cp "${TMP_DIR}/LICENSE" "${TARGET_DIR}/"

echo "Pinned pstack @ ${SHA} vendored to ${TARGET_DIR}"
