#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER_DEFAULT="${SUDO_USER:-$USER}"
SERVICE_USER="$SERVICE_USER_DEFAULT"
SERVICE_GROUP=""
SERVICE_HOME=""

CORE_LAUNCHD_LABEL="com.mailfastapi.core"
WEB_LAUNCHD_LABEL="com.mailfastapi.web"
CORE_ENTRY="src/app.js"
WEB_ENTRY="src/web.js"
ENV_FILE=".env"
ENV_TEMPLATE_FILE=".env.example"
GITHUB_URL="https://github.com/KES-KING/mailFastApi"

SKIP_SYSTEM_DEPS="false"
SKIP_SERVICE_SETUP="false"
SKIP_NPM_INSTALL="false"

BREW_BIN=""
BREW_ENV_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NODE_BIN=""
NPM_BIN=""

RED="\033[1;31m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
BLUE="\033[1;34m"
MAGENTA="\033[1;35m"
CYAN="\033[1;36m"
RESET="\033[0m"

print_banner() {
  echo -e "${CYAN}"
  cat <<'EOF'
 __  __       _ _ _____          _      _    ____  _
|  \/  | __ _(_) |  ___|_ _  ___| |_   / \  |  _ \(_)
| |\/| |/ _` | | | |_ / _` |/ __| __| / _ \ | |_) | |
| |  | | (_| | | |  _| (_| | (__| |_ / ___ \|  __/| |
|_|  |_|\__,_|_|_|_|  \__,_|\___|\__/_/   \_\_|   |_|
EOF
  echo -e "${RESET}${MAGENTA}macOS Installer (Core + Web)${RESET}"
  echo -e "${CYAN}GitHub:${RESET} ${GITHUB_URL}"
  echo ""
}

info() { echo -e "${BLUE}[INFO]${RESET} $*"; }
ok() { echo -e "${GREEN}[OK]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }
err() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }

usage() {
  cat <<EOF
Usage: ./macosinstaller.sh [options]

Options:
  --service-user <user>      runtime user (default: ${SERVICE_USER_DEFAULT})
  --app-dir <path>           project directory (default: script directory)
  --skip-system-deps         skip Homebrew dependency install
  --skip-service             skip launchd LaunchAgent creation/load
  --skip-npm                 skip npm dependency install
  -h, --help                 show this help
EOF
}

run_as_user() {
  local user="$1"
  shift

  if [[ "$(id -un)" == "$user" ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo -u "$user" -H "$@"
    return
  fi

  su - "$user" -c "$(printf '%q ' "$@")"
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-user)
      if [[ $# -lt 2 ]]; then
        err "--service-user requires a value."
        exit 1
      fi
      SERVICE_USER="$2"
      shift 2
      ;;
    --app-dir)
      if [[ $# -lt 2 ]]; then
        err "--app-dir requires a value."
        exit 1
      fi
      APP_DIR="$2"
      shift 2
      ;;
    --skip-system-deps)
      SKIP_SYSTEM_DEPS="true"
      shift
      ;;
    --skip-service)
      SKIP_SERVICE_SETUP="true"
      shift
      ;;
    --skip-npm)
      SKIP_NPM_INSTALL="true"
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

APP_DIR="$(cd "$APP_DIR" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "This installer is intended for macOS (Darwin) systems."
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  err "APP_DIR does not exist: $APP_DIR"
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  err "package.json not found in APP_DIR"
  exit 1
fi

if [[ ! -f "$APP_DIR/$CORE_ENTRY" ]]; then
  err "$CORE_ENTRY not found in APP_DIR"
  exit 1
fi

if [[ ! -f "$APP_DIR/$WEB_ENTRY" ]]; then
  err "$WEB_ENTRY not found in APP_DIR"
  exit 1
fi

if [[ ! -f "$APP_DIR/updater.sh" ]]; then
  err "updater.sh not found in APP_DIR"
  exit 1
fi

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  err "Service user does not exist: $SERVICE_USER"
  exit 1
fi

SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
SERVICE_HOME="$(dscl . -read "/Users/$SERVICE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
if [[ -z "$SERVICE_HOME" ]]; then
  SERVICE_HOME="/Users/$SERVICE_USER"
fi

find_brew() {
  if command -v brew >/dev/null 2>&1; then
    BREW_BIN="$(command -v brew)"
    return
  fi

  if [[ -x "/opt/homebrew/bin/brew" ]]; then
    BREW_BIN="/opt/homebrew/bin/brew"
    return
  fi

  if [[ -x "/usr/local/bin/brew" ]]; then
    BREW_BIN="/usr/local/bin/brew"
    return
  fi
}

brew_has_formula() {
  local formula="$1"
  run_as_user "$SERVICE_USER" env PATH="$BREW_ENV_PATH" "$BREW_BIN" list --versions "$formula" >/dev/null 2>&1
}

brew_install_formula_if_missing() {
  local formula="$1"
  if brew_has_formula "$formula"; then
    info "Homebrew formula already installed: $formula"
    return
  fi

  info "Installing Homebrew formula: $formula"
  run_as_user "$SERVICE_USER" env PATH="$BREW_ENV_PATH" "$BREW_BIN" install "$formula"
}

install_system_dependencies() {
  find_brew
  if [[ -z "$BREW_BIN" ]]; then
    err "Homebrew is required for system dependency install."
    err "Install Homebrew first: https://brew.sh"
    exit 1
  fi

  info "Updating Homebrew..."
  run_as_user "$SERVICE_USER" env PATH="$BREW_ENV_PATH" "$BREW_BIN" update

  brew_install_formula_if_missing "git"
  brew_install_formula_if_missing "redis"
  brew_install_formula_if_missing "sqlite"
  brew_install_formula_if_missing "python"
}

node_major_from_bin() {
  local node_bin="$1"
  if [[ -x "$node_bin" ]]; then
    "$node_bin" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0"
    return
  fi
  echo "0"
}

resolve_node_and_npm_binaries() {
  NODE_BIN=""
  NPM_BIN=""

  if command -v node >/dev/null 2>&1; then
    local current_node current_major
    current_node="$(command -v node)"
    current_major="$(node_major_from_bin "$current_node")"
    if [[ "$current_major" -ge 20 ]]; then
      NODE_BIN="$current_node"
      if command -v npm >/dev/null 2>&1; then
        NPM_BIN="$(command -v npm)"
      elif [[ -x "$(dirname "$current_node")/npm" ]]; then
        NPM_BIN="$(dirname "$current_node")/npm"
      fi
      return
    fi
  fi

  if [[ -n "$BREW_BIN" ]]; then
    local node22_prefix node22_bin node22_npm node22_major
    node22_prefix="$(run_as_user "$SERVICE_USER" env PATH="$BREW_ENV_PATH" "$BREW_BIN" --prefix node@22 2>/dev/null || true)"
    node22_bin="${node22_prefix}/bin/node"
    node22_npm="${node22_prefix}/bin/npm"
    node22_major="$(node_major_from_bin "$node22_bin")"

    if [[ "$node22_major" -ge 20 && -x "$node22_npm" ]]; then
      NODE_BIN="$node22_bin"
      NPM_BIN="$node22_npm"
      return
    fi
  fi
}

install_node_lts_if_needed() {
  resolve_node_and_npm_binaries
  if [[ -n "$NODE_BIN" && -n "$NPM_BIN" ]]; then
    ok "Node.js version is suitable (>=20)."
    return
  fi

  find_brew
  if [[ -z "$BREW_BIN" ]]; then
    err "Node.js >=20 required, but Homebrew is missing."
    exit 1
  fi

  info "Installing Node.js 22 LTS via Homebrew..."
  run_as_user "$SERVICE_USER" env PATH="$BREW_ENV_PATH" "$BREW_BIN" install node@22

  resolve_node_and_npm_binaries
  if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
    err "Could not resolve Node.js >=20 binaries after installation."
    err "Check your PATH or Homebrew node@22 installation."
    exit 1
  fi

  ok "Node.js installed successfully."
}

ensure_redis_running() {
  if [[ -z "$BREW_BIN" ]]; then
    find_brew
  fi

  if [[ -z "$BREW_BIN" ]]; then
    warn "Homebrew not found. Ensure Redis is running manually."
    return
  fi

  info "Ensuring Redis is running via brew services..."
  if run_as_user "$SERVICE_USER" env PATH="$BREW_ENV_PATH" "$BREW_BIN" services start redis >/dev/null 2>&1; then
    ok "Redis service started (brew services)."
  else
    warn "Could not auto-start Redis. Start manually: brew services start redis"
  fi
}

get_env_value() {
  local key="$1"
  local fallback="$2"
  local value=""

  if [[ -f "$APP_DIR/$ENV_FILE" ]]; then
    value="$(grep -E "^${key}=" "$APP_DIR/$ENV_FILE" | tail -n 1 | cut -d'=' -f2- || true)"
  fi

  if [[ -n "$value" ]]; then
    echo "$value"
  else
    echo "$fallback"
  fi
}

set_env_default() {
  local key="$1"
  local value="$2"
  local env_path="$APP_DIR/$ENV_FILE"

  if grep -qE "^${key}=" "$env_path"; then
    return
  fi
  printf '\n%s=%s\n' "$key" "$value" >> "$env_path"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
    return
  fi
  date +%s | shasum -a 256 | awk '{print $1}'
}

ensure_env_file() {
  local env_path="$APP_DIR/$ENV_FILE"
  local template_path="$APP_DIR/$ENV_TEMPLATE_FILE"

  if [[ ! -f "$env_path" ]]; then
    if [[ ! -f "$template_path" ]]; then
      err "$ENV_TEMPLATE_FILE is missing."
      exit 1
    fi
    cp "$template_path" "$env_path"
    ok ".env created from $ENV_TEMPLATE_FILE"
  else
    info ".env already exists, preserving current values."
  fi

  local port
  local monitor_token
  port="$(get_env_value "PORT" "3000")"
  monitor_token="$(get_env_value "MONITOR_TOKEN" "")"

  if [[ -z "$monitor_token" ]]; then
    monitor_token="$(generate_secret)"
    warn "MONITOR_TOKEN was empty. Generated a secure token."
    printf '\nMONITOR_TOKEN=%s\n' "$monitor_token" >> "$env_path"
  fi

  set_env_default "MONITOR_ENABLED" "true"
  set_env_default "MONITOR_UI_ENABLED" "false"
  set_env_default "MONITOR_PATH" "/monitor"
  set_env_default "METRICS_PATH" "/metrics"
  set_env_default "WEB_PORT" "3300"
  set_env_default "WEB_HOST" "0.0.0.0"
  set_env_default "WEB_CORE_BASE_URL" "http://127.0.0.1:${port}"
  set_env_default "WEB_ENABLE_UPDATER" "true"
  set_env_default "WEB_UPDATE_SCRIPT" "./updater.sh"
  set_env_default "WEB_UPDATE_TIMEOUT_MS" "180000"
  set_env_default "WEB_UPDATE_TOKEN" ""

  if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
    run_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$env_path" >/dev/null 2>&1 || true
    run_privileged chmod 640 "$env_path" >/dev/null 2>&1 || true
  else
    chmod 600 "$env_path" || true
  fi

  ok ".env defaults verified."
}

check_port() {
  local port="$1"
  local label="$2"

  if [[ -z "$port" ]]; then
    return
  fi

  if ! [[ "$port" =~ ^[0-9]+$ ]]; then
    warn "$label port is not numeric: $port"
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      warn "$label port seems busy: $port"
      return
    fi
    ok "$label port available: $port"
    return
  fi

  warn "Could not verify port availability (lsof missing)."
}

create_runtime_dirs() {
  info "Creating runtime directories..."
  mkdir -p \
    "$APP_DIR/data" \
    "$APP_DIR/run" \
    "$APP_DIR/logs" \
    "$APP_DIR/logs/core" \
    "$APP_DIR/logs/web" \
    "$APP_DIR/logs/install"

  chmod +x "$APP_DIR/updater.sh" "$APP_DIR/macosinstaller.sh" || true

  if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
    run_privileged chown -R "$SERVICE_USER:$SERVICE_GROUP" \
      "$APP_DIR/data" "$APP_DIR/run" "$APP_DIR/logs" >/dev/null 2>&1 || true
    run_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR/updater.sh" >/dev/null 2>&1 || true
    run_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR/macosinstaller.sh" >/dev/null 2>&1 || true
  fi

  ok "Runtime directories ready."
}

run_npm_install() {
  if [[ "$SKIP_NPM_INSTALL" == "true" ]]; then
    warn "Skipping npm install by request."
    return
  fi

  if [[ -z "$NPM_BIN" ]]; then
    err "npm binary could not be resolved."
    exit 1
  fi

  info "Installing npm dependencies..."
  run_as_user "$SERVICE_USER" bash -lc "cd \"$APP_DIR\" && \"$NPM_BIN\" install --omit=dev"
  ok "npm install completed."
}

run_syntax_checks() {
  if [[ -z "$NODE_BIN" ]]; then
    err "node binary could not be resolved."
    exit 1
  fi

  info "Running syntax checks..."
  run_as_user "$SERVICE_USER" bash -lc "cd \"$APP_DIR\" && \"$NODE_BIN\" --check \"$CORE_ENTRY\""
  run_as_user "$SERVICE_USER" bash -lc "cd \"$APP_DIR\" && \"$NODE_BIN\" --check \"$WEB_ENTRY\""
  ok "Syntax checks passed."
}

write_launch_agent_plist() {
  local label="$1"
  local entry="$2"
  local out_path="$3"
  local std_out="$4"
  local std_err="$5"
  local service_path

  service_path="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  cat > "$out_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${APP_DIR}/${entry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>${service_path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${std_out}</string>
  <key>StandardErrorPath</key>
  <string>${std_err}</string>
</dict>
</plist>
EOF
}

setup_launchd_services() {
  if [[ "$SKIP_SERVICE_SETUP" == "true" ]]; then
    warn "Skipping service setup by request."
    return
  fi

  if ! command -v launchctl >/dev/null 2>&1; then
    warn "launchctl not available. Cannot auto-create services."
    return
  fi

  local launch_agents_dir core_plist web_plist
  launch_agents_dir="${SERVICE_HOME}/Library/LaunchAgents"
  core_plist="${launch_agents_dir}/${CORE_LAUNCHD_LABEL}.plist"
  web_plist="${launch_agents_dir}/${WEB_LAUNCHD_LABEL}.plist"

  info "Creating launchd LaunchAgents..."
  run_as_user "$SERVICE_USER" mkdir -p "$launch_agents_dir"

  write_launch_agent_plist \
    "$CORE_LAUNCHD_LABEL" \
    "$CORE_ENTRY" \
    "$core_plist" \
    "$APP_DIR/logs/core/launchd.out.log" \
    "$APP_DIR/logs/core/launchd.err.log"

  write_launch_agent_plist \
    "$WEB_LAUNCHD_LABEL" \
    "$WEB_ENTRY" \
    "$web_plist" \
    "$APP_DIR/logs/web/launchd.out.log" \
    "$APP_DIR/logs/web/launchd.err.log"

  if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
    run_privileged chown "$SERVICE_USER:$SERVICE_GROUP" "$core_plist" "$web_plist" >/dev/null 2>&1 || true
  fi

  if run_as_user "$SERVICE_USER" bash -lc "launchctl unload '$core_plist' >/dev/null 2>&1 || true; launchctl unload '$web_plist' >/dev/null 2>&1 || true; launchctl load '$core_plist'; launchctl load '$web_plist'"; then
    ok "LaunchAgents loaded: ${CORE_LAUNCHD_LABEL}, ${WEB_LAUNCHD_LABEL}"
  else
    warn "Could not auto-load LaunchAgents in current session."
    warn "Load manually as ${SERVICE_USER}:"
    echo "  launchctl load '$core_plist'"
    echo "  launchctl load '$web_plist'"
  fi
}

print_post_install() {
  local port web_port
  local core_plist web_plist
  port="$(get_env_value "PORT" "3000")"
  web_port="$(get_env_value "WEB_PORT" "3300")"
  core_plist="${SERVICE_HOME}/Library/LaunchAgents/${CORE_LAUNCHD_LABEL}.plist"
  web_plist="${SERVICE_HOME}/Library/LaunchAgents/${WEB_LAUNCHD_LABEL}.plist"

  echo ""
  ok "Installation completed."
  echo -e "${CYAN}Core Agent${RESET} : ${CORE_LAUNCHD_LABEL}"
  echo -e "${CYAN}Web Agent${RESET}  : ${WEB_LAUNCHD_LABEL}"
  echo -e "${CYAN}App Dir${RESET}    : ${APP_DIR}"
  echo -e "${CYAN}Env File${RESET}   : ${APP_DIR}/${ENV_FILE}"
  echo ""
  echo "URLs (default):"
  echo "  Core Health : http://127.0.0.1:${port}/health"
  echo "  Web Monitor : http://127.0.0.1:${web_port}/monitor"
  echo ""
  echo "Useful commands:"
  echo "  launchctl list | grep mailfastapi"
  echo "  launchctl unload '${core_plist}' && launchctl load '${core_plist}'"
  echo "  launchctl unload '${web_plist}' && launchctl load '${web_plist}'"
  echo "  tail -f '${APP_DIR}/logs/core/launchd.err.log'"
  echo "  tail -f '${APP_DIR}/logs/web/launchd.err.log'"
  echo "  ./updater.sh"
  echo ""
  warn "Updater script restart step is systemd-based; on macOS, restart LaunchAgents manually after updates if needed."
  warn "Review .env values (SMTP, auth, ports, tokens) before production traffic."
}

main() {
  print_banner

  info "App dir           : ${APP_DIR}"
  info "Service user      : ${SERVICE_USER}"
  info "Skip system deps  : ${SKIP_SYSTEM_DEPS}"
  info "Skip service setup: ${SKIP_SERVICE_SETUP}"
  info "Skip npm install  : ${SKIP_NPM_INSTALL}"
  echo ""

  find_brew

  if [[ "$SKIP_SYSTEM_DEPS" != "true" ]]; then
    install_system_dependencies
    install_node_lts_if_needed
    ensure_redis_running
  else
    warn "Skipping system dependencies by request."
    install_node_lts_if_needed
  fi

  ensure_env_file

  local core_port web_port
  core_port="$(get_env_value "PORT" "3000")"
  web_port="$(get_env_value "WEB_PORT" "3300")"
  check_port "$core_port" "Core"
  check_port "$web_port" "Web"

  create_runtime_dirs
  run_npm_install
  run_syntax_checks
  setup_launchd_services
  print_post_install
}

main "$@"
