#!/usr/bin/env bash
# Install dsc globally from a local tarball (built by `npm run package`).
#
# Usage:
#   scripts/install.sh                       # auto-find pkg/dsc-*.tgz
#   scripts/install.sh /path/to/dsc-X.Y.Z.tgz
#   scripts/install.sh --user                # force user-local prefix setup
#   scripts/install.sh --system              # use the existing prefix (sudo if needed)
#
# Linux / macOS. For Windows, see install.ps1.
#
# By default this script steers npm toward a user-owned global prefix
# (~/.local) so `npm install -g` doesn't need sudo and `/update` from
# inside dsc keeps working without a permission dance. If the existing
# prefix is already user-writable, we leave it alone.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MODE=auto
TARBALL=""
for arg in "$@"; do
  case "$arg" in
    --user)   MODE=user ;;
    --system) MODE=system ;;
    *)        TARBALL="$arg" ;;
  esac
done

if [ -z "$TARBALL" ]; then
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

# Inspect current npm prefix. If it's root-owned and we're not root,
# `npm install -g` will EACCES; offer to set up a user prefix instead.
CURRENT_PREFIX="$(npm config get prefix 2>/dev/null || echo "")"
USER_PREFIX="$HOME/.local"

needs_user_prefix() {
  # Pre-decision overrides from flags.
  if [ "$MODE" = user ]; then return 0; fi
  if [ "$MODE" = system ]; then return 1; fi
  # Auto: switch to user prefix if the current one isn't writable and we
  # aren't already root. Running as root means the user picked sudo
  # deliberately; respect that.
  [ "$(id -u)" -ne 0 ] && [ -n "$CURRENT_PREFIX" ] && [ ! -w "$CURRENT_PREFIX/lib" ] 2>/dev/null
}

if needs_user_prefix; then
  echo "▶ current npm prefix '$CURRENT_PREFIX' is not user-writable."
  echo "  switching to '$USER_PREFIX' so 'npm install -g' (and dsc's /update) work without sudo."
  mkdir -p "$USER_PREFIX/bin" "$USER_PREFIX/lib"
  npm config set prefix "$USER_PREFIX"

  case ":$PATH:" in
    *":$USER_PREFIX/bin:"*) ;;
    *)
      echo
      echo "  add this to your shell rc (~/.bashrc, ~/.zshrc) so 'dsc' is on PATH:"
      echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
fi

echo "▶ installing $TARBALL globally"
npm install -g "$TARBALL"

if command -v dsc >/dev/null 2>&1; then
  echo
  echo "✓ dsc installed: $(command -v dsc)"
  echo "  next: run 'dsc' and use '/api-key sk-...' to save your DeepSeek key"
else
  echo
  echo "✓ install completed but 'dsc' is not on PATH."
  echo "  bin lives at: $(npm config get prefix)/bin"
  echo "  add that directory to PATH and reopen the terminal."
fi
