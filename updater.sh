#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATER_JS="$APP_DIR/scripts/updater.js"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node command not found." >&2
  exit 1
fi

if [[ ! -f "$UPDATER_JS" ]]; then
  echo "[ERROR] Node updater not found: $UPDATER_JS" >&2
  exit 1
fi

exec node "$UPDATER_JS" "$@"
