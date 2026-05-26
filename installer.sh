#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'EOF'
Usage: ./installer.sh [options]

Cross-platform installer entrypoint.

Linux:
  dispatches to ./install.sh

macOS:
  dispatches to ./macosinstaller.sh

Windows:
  from Git Bash/MSYS/Cygwin, dispatches to ./install.ps1 through PowerShell.
  from native Windows shells, use .\install.ps1 or installer.cmd.

Common options:
  --service-user <user>      runtime user where supported
  --app-dir <path>           project directory
  --skip-system-deps         skip package-manager dependency install
  --skip-service             skip service/task registration
  --skip-npm                 skip npm dependency install
  -h, --help                 show this help
EOF
}

to_windows_path() {
  local value="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$value"
    return
  fi
  echo "$value"
}

dispatch_windows() {
  local powershell_bin=""
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell_bin="$(command -v powershell.exe)"
  elif command -v pwsh.exe >/dev/null 2>&1; then
    powershell_bin="$(command -v pwsh.exe)"
  elif command -v pwsh >/dev/null 2>&1; then
    powershell_bin="$(command -v pwsh)"
  fi

  if [[ -z "$powershell_bin" ]]; then
    echo "[ERROR] PowerShell is required on Windows." >&2
    exit 1
  fi

  local ps_script
  ps_script="$(to_windows_path "$SCRIPT_DIR/install.ps1")"

  local ps_args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --service-user)
        if [[ $# -lt 2 ]]; then
          echo "[ERROR] --service-user requires a value." >&2
          exit 1
        fi
        ps_args+=("-ServiceUser" "$2")
        shift 2
        ;;
      --app-dir)
        if [[ $# -lt 2 ]]; then
          echo "[ERROR] --app-dir requires a value." >&2
          exit 1
        fi
        ps_args+=("-AppDir" "$(to_windows_path "$2")")
        shift 2
        ;;
      --skip-system-deps)
        ps_args+=("-SkipSystemDeps")
        shift
        ;;
      --skip-service)
        ps_args+=("-SkipService")
        shift
        ;;
      --skip-npm)
        ps_args+=("-SkipNpm")
        shift
        ;;
      -h|--help)
        ps_args+=("-Help")
        shift
        ;;
      *)
        ps_args+=("$1")
        shift
        ;;
    esac
  done

  "$powershell_bin" -NoProfile -ExecutionPolicy Bypass -File "$ps_script" "${ps_args[@]}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  echo ""
fi

case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux*)
    exec "$SCRIPT_DIR/install.sh" "$@"
    ;;
  Darwin*)
    exec "$SCRIPT_DIR/macosinstaller.sh" "$@"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    dispatch_windows "$@"
    ;;
  *)
    echo "[ERROR] Unsupported platform: $(uname -s 2>/dev/null || echo unknown)" >&2
    echo "Use install.sh on Linux, macosinstaller.sh on macOS, or install.ps1 on Windows." >&2
    exit 1
    ;;
esac
