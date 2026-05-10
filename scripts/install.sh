#!/usr/bin/env bash
# Install dsc globally from a local tarball (built by `npm run package`).
#
# Usage:
#   scripts/install.sh                       # auto-find pkg/dsc-*.tgz
#   scripts/install.sh /path/to/dsc-X.Y.Z.tgz
#
# Linux / macOS. For Windows, see install.ps1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" != "" ]; then
  TARBALL="$1"
else
  TARBALL="$(ls -1t "$REPO_ROOT/pkg"/*.tgz 2>/dev/null | head -n1 || true)"
  if [ -z "$TARBALL" ]; then
    echo "no tarball found in $REPO_ROOT/pkg/. Run \`npm run package\` first." >&2
    exit 1
  fi
fi

if [ ! -f "$TARBALL" ]; then
  echo "tarball not found: $TARBALL" >&2
  exit 1
fi

echo "▶ installing $TARBALL globally"
npm install -g "$TARBALL"

if command -v dsc >/dev/null 2>&1; then
  echo
  echo "✓ dsc installed: $(command -v dsc)"
  echo "  set DEEPSEEK_API_KEY or create ~/.config/deepseek/deepseek.json, then run: dsc"
else
  echo
  echo "✓ install completed but \`dsc\` is not on PATH."
  echo "  Check your npm global bin: npm config get prefix"
fi
