#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_SERVICE_NAME="mailfastapi-core.service"
WEB_SERVICE_NAME="mailfastapi-web.service"

MODE="interactive"
JSON_OUTPUT="false"
ASSUME_YES="false"
ALLOW_DIRTY="false"
SKIP_RESTART="false"

LATEST_SHA=""
LATEST_SHORT_SHA=""
LATEST_SUBJECT=""
LATEST_AUTHOR=""
LATEST_DATE=""
UPSTREAM_REF=""
REMOTE_NAME=""
LOCAL_SHA=""
REMOTE_SHA=""

info() { echo "[INFO] $*"; }
warn() { echo "[WARN] $*"; }
err() { echo "[ERROR] $*" >&2; }

json_escape() {
  local input="${1:-}"
  input="${input//\\/\\\\}"
  input="${input//\"/\\\"}"
  input="${input//$'\n'/\\n}"
  input="${input//$'\r'/}"
  input="${input//$'\t'/\\t}"
  printf '%s' "$input"
}

emit_json() {
  local ok="$1"
  local code="$2"
  local message="$3"
  local update_available="$4"
  local applied="$5"

  printf '{'
  printf '"ok":%s,' "$ok"
  printf '"code":"%s",' "$(json_escape "$code")"
  printf '"message":"%s",' "$(json_escape "$message")"
  printf '"updateAvailable":%s,' "$update_available"
  printf '"applied":%s,' "$applied"
  printf '"branch":"%s",' "$(json_escape "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')")"
  printf '"localSha":"%s",' "$(json_escape "$LOCAL_SHA")"
  printf '"remoteSha":"%s",' "$(json_escape "$REMOTE_SHA")"
  printf '"upstream":"%s",' "$(json_escape "$UPSTREAM_REF")"
  printf '"remote":"%s",' "$(json_escape "$REMOTE_NAME")"
  printf '"latest":{'
  printf '"sha":"%s",' "$(json_escape "$LATEST_SHA")"
  printf '"shortSha":"%s",' "$(json_escape "$LATEST_SHORT_SHA")"
  printf '"subject":"%s",' "$(json_escape "$LATEST_SUBJECT")"
  printf '"author":"%s",' "$(json_escape "$LATEST_AUTHOR")"
  printf '"date":"%s"' "$(json_escape "$LATEST_DATE")"
  printf '}'
  printf '}'
  printf '\n'
}

emit_result() {
  local ok="$1"
  local code="$2"
  local message="$3"
  local update_available="$4"
  local applied="$5"
  local exit_code="$6"

  if [[ "$JSON_OUTPUT" == "true" ]]; then
    emit_json "$ok" "$code" "$message" "$update_available" "$applied"
  else
    if [[ "$ok" == "true" ]]; then
      info "$message"
    else
      err "$message"
    fi

    if [[ "$update_available" == "true" && -n "$LATEST_SHORT_SHA" ]]; then
      echo "- Upstream: $UPSTREAM_REF"
      echo "- Commit : $LATEST_SHORT_SHA"
      echo "- Subject: $LATEST_SUBJECT"
      echo "- Author : $LATEST_AUTHOR"
      echo "- Date   : $LATEST_DATE"
    fi
  fi

  exit "$exit_code"
}

usage() {
  cat <<'EOF'
Usage: ./updater.sh [options]

Modes:
  --check              Only check update status and exit.
  --apply              Apply update without interactive prompt.
  (default)            Interactive mode: check + ask + apply.

Options:
  --yes                Skip confirmation prompt (used with --apply or interactive).
  --allow-dirty        Allow update even if working tree has local changes.
  --skip-restart       Do not restart systemd services after update.
  --json               Output machine-readable JSON.
  -h, --help           Show help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      MODE="check"
      shift
      ;;
    --apply)
      MODE="apply"
      shift
      ;;
    --yes)
      ASSUME_YES="true"
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY="true"
      shift
      ;;
    --skip-restart)
      SKIP_RESTART="true"
      shift
      ;;
    --json)
      JSON_OUTPUT="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

ensure_requirements() {
  command -v git >/dev/null 2>&1 || emit_result "false" "MISSING_GIT" "git command not found." "false" "false" 1
  command -v npm >/dev/null 2>&1 || emit_result "false" "MISSING_NPM" "npm command not found." "false" "false" 1

  if [[ ! -d "$APP_DIR/.git" ]]; then
    emit_result "false" "NOT_A_REPO" "Project directory is not a git repository: $APP_DIR" "false" "false" 1
  fi

  cd "$APP_DIR"
}

resolve_upstream_ref() {
  local current_branch=""
  current_branch="$(git rev-parse --abbrev-ref HEAD)"

  UPSTREAM_REF="$(git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null || true)"
  if [[ -n "$UPSTREAM_REF" ]]; then
    return
  fi

  if git show-ref --verify --quiet "refs/remotes/${REMOTE_NAME}/${current_branch}"; then
    UPSTREAM_REF="${REMOTE_NAME}/${current_branch}"
    return
  fi

  if git show-ref --verify --quiet "refs/remotes/${REMOTE_NAME}/main"; then
    UPSTREAM_REF="${REMOTE_NAME}/main"
    return
  fi

  if git show-ref --verify --quiet "refs/remotes/${REMOTE_NAME}/master"; then
    UPSTREAM_REF="${REMOTE_NAME}/master"
    return
  fi

  emit_result "false" "UPSTREAM_NOT_FOUND" "Could not resolve upstream reference." "false" "false" 1
}

resolve_remote_name() {
  if git remote | grep -qx "origin"; then
    REMOTE_NAME="origin"
    return
  fi

  REMOTE_NAME="$(git remote | head -n 1 || true)"
  if [[ -z "$REMOTE_NAME" ]]; then
    emit_result "false" "REMOTE_NOT_FOUND" "No git remote configured." "false" "false" 1
  fi
}

check_for_update() {
  resolve_remote_name
  git fetch --prune --tags "$REMOTE_NAME" >/dev/null 2>&1

  resolve_upstream_ref

  LOCAL_SHA="$(git rev-parse HEAD)"
  REMOTE_SHA="$(git rev-parse "$UPSTREAM_REF")"

  LATEST_SHA="$REMOTE_SHA"
  LATEST_SHORT_SHA="$(git rev-parse --short "$UPSTREAM_REF")"
  LATEST_SUBJECT="$(git log -n 1 --format=%s "$UPSTREAM_REF")"
  LATEST_AUTHOR="$(git log -n 1 --format=%an "$UPSTREAM_REF")"
  LATEST_DATE="$(git log -n 1 --format=%aI "$UPSTREAM_REF")"

  if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
    return 1
  fi

  return 0
}

ensure_clean_if_needed() {
  if [[ "$ALLOW_DIRTY" == "true" ]]; then
    return
  fi

  if [[ -n "$(git status --porcelain)" ]]; then
    emit_result "false" "WORKTREE_DIRTY" "Working tree has local changes. Commit/stash first or rerun with --allow-dirty." "true" "false" 2
  fi
}

run_dependency_sync() {
  if [[ -f "package-lock.json" ]]; then
    npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null 2>&1
    return
  fi

  npm install --omit=dev >/dev/null 2>&1
}

restart_services() {
  if [[ "$SKIP_RESTART" == "true" ]]; then
    return
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not available, skipping service restart."
    return
  fi

  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl restart "$CORE_SERVICE_NAME" "$WEB_SERVICE_NAME"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo systemctl restart "$CORE_SERVICE_NAME" "$WEB_SERVICE_NAME"
    return
  fi

  emit_result "false" "SUDO_REQUIRED" "Service restart requires root or sudo." "true" "false" 1
}

apply_update() {
  ensure_clean_if_needed

  git merge --ff-only "$UPSTREAM_REF" >/dev/null 2>&1
  run_dependency_sync
  restart_services
}

interactive_confirm() {
  if [[ "$ASSUME_YES" == "true" ]]; then
    return 0
  fi

  if [[ ! -r /dev/tty ]] || [[ ! -w /dev/tty ]]; then
    emit_result "false" "TTY_REQUIRED" "Interactive mode requires a TTY. Use --apply --yes for non-interactive." "true" "false" 1
  fi

  printf "Yeni guncelleme bulundu: %s - %s\n" "$LATEST_SHORT_SHA" "$LATEST_SUBJECT" > /dev/tty
  printf "Guncelleme yuklensin mi? (y/n): " > /dev/tty
  local answer=""
  read -r answer < /dev/tty
  case "$answer" in
    y|Y|yes|YES|Yes|e|E|evet|EVET|Evet)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

main() {
  ensure_requirements

  if check_for_update; then
    if [[ "$MODE" == "check" ]]; then
      emit_result "true" "UPDATE_AVAILABLE" "Yeni commit bulundu." "true" "false" 0
    fi

    if [[ "$MODE" == "interactive" ]]; then
      if ! interactive_confirm; then
        emit_result "true" "CANCELLED" "Guncelleme islemi iptal edildi." "true" "false" 0
      fi
    fi

    apply_update
    emit_result "true" "UPDATED" "Guncelleme basariyla yuklendi ve servisler yeniden baslatildi." "true" "true" 0
  else
    emit_result "true" "UP_TO_DATE" "Sistem guncel. Yeni commit bulunmuyor." "false" "false" 0
  fi
}

main "$@"
