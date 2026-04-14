#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER_DEFAULT="${SUDO_USER:-$USER}"
SERVICE_USER="$SERVICE_USER_DEFAULT"
SERVICE_GROUP=""

CORE_SERVICE_NAME="mailfastapi-core"
WEB_SERVICE_NAME="mailfastapi-web"
CORE_ENTRY="src/app.js"
WEB_ENTRY="src/web.js"
ENV_FILE=".env"
ENV_TEMPLATE_FILE=".env.example"
GITHUB_URL="https://github.com/KES-KING/mailFastApi"

SKIP_SYSTEM_DEPS="false"
SKIP_SERVICE_SETUP="false"
SKIP_NPM_INSTALL="false"

RED="\033[1;31m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
BLUE="\033[1;34m"
MAGENTA="\033[1;35m"
CYAN="\033[1;36m"
RESET="\033[0m"

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo -e "${RED}[ERROR]${RESET} sudo is required."
    exit 1
  fi
fi

print_banner() {
  echo -e "${CYAN}"
  cat <<'EOF'
 __  __       _ _ _____          _      _    ____  _
|  \/  | __ _(_) |  ___|_ _  ___| |_   / \  |  _ \(_)
| |\/| |/ _` | | | |_ / _` |/ __| __| / _ \ | |_) | |
| |  | | (_| | | |  _| (_| | (__| |_ / ___ \|  __/| |
|_|  |_|\__,_|_|_|_|  \__,_|\___|\__/_/   \_\_|   |_|
EOF
  echo -e "${RESET}${MAGENTA}Core + Web Installer${RESET}"
  echo -e "${CYAN}GitHub:${RESET} ${GITHUB_URL}"
  echo ""
}

info() { echo -e "${BLUE}[INFO]${RESET} $*"; }
ok() { echo -e "${GREEN}[OK]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }
err() { echo -e "${RED}[ERROR]${RESET} $*"; }

usage() {
  cat <<EOF
Usage: ./install.sh [options]

Options:
  --service-user <user>      service runtime user (default: ${SERVICE_USER_DEFAULT})
  --app-dir <path>           project directory (default: script directory)
  --skip-system-deps         skip package manager installs
  --skip-service             skip systemd unit creation/start
  --skip-npm                 skip npm dependency install
  -h, --help                 show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-user)
      SERVICE_USER="$2"
      shift 2
      ;;
    --app-dir)
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

if [[ "$OSTYPE" != "linux-gnu"* ]] && [[ "$(uname -s)" != "Linux" ]]; then
  err "This installer is intended for Linux systems."
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

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then echo "apt"; return; fi
  if command -v dnf >/dev/null 2>&1; then echo "dnf"; return; fi
  if command -v yum >/dev/null 2>&1; then echo "yum"; return; fi
  if command -v pacman >/dev/null 2>&1; then echo "pacman"; return; fi
  if command -v zypper >/dev/null 2>&1; then echo "zypper"; return; fi
  echo ""
}

PKG_MANAGER="$(detect_pkg_manager)"

install_system_dependencies() {
  if [[ -z "$PKG_MANAGER" ]]; then
    warn "No supported package manager detected. Skipping system dependencies."
    return
  fi

  info "Installing system dependencies via $PKG_MANAGER..."
  case "$PKG_MANAGER" in
    apt)
      ${SUDO} apt-get update -y
      ${SUDO} apt-get install -y \
        curl ca-certificates gnupg lsb-release git build-essential sqlite3 redis-server \
        python3 python3-pip python3-venv
      ;;
    dnf)
      ${SUDO} dnf install -y \
        curl ca-certificates gnupg2 git gcc-c++ make sqlite redis \
        python3 python3-pip python3-virtualenv
      ;;
    yum)
      ${SUDO} yum install -y \
        curl ca-certificates gnupg2 git gcc-c++ make sqlite redis \
        python3 python3-pip python3-virtualenv
      ;;
    pacman)
      ${SUDO} pacman -Sy --noconfirm --needed \
        curl ca-certificates gnupg git base-devel sqlite redis \
        python python-pip
      ;;
    zypper)
      ${SUDO} zypper --non-interactive install \
        curl ca-certificates gpg2 git gcc-c++ make sqlite3 redis \
        python3 python3-pip python3-virtualenv
      ;;
  esac
  ok "System dependencies installed."
}

node_major_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "0"
    return
  fi
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0"
}

install_node_lts_if_needed() {
  local major
  major="$(node_major_version)"

  if [[ "$major" -ge 20 ]]; then
    ok "Node.js version is suitable (>=20)."
    return
  fi

  info "Installing Node.js 22.x LTS..."
  case "$PKG_MANAGER" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO} -E bash -
      ${SUDO} apt-get install -y nodejs
      ;;
    dnf)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | ${SUDO} bash -
      ${SUDO} dnf install -y nodejs
      ;;
    yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | ${SUDO} bash -
      ${SUDO} yum install -y nodejs
      ;;
    pacman)
      ${SUDO} pacman -Sy --noconfirm --needed nodejs npm
      ;;
    zypper)
      ${SUDO} zypper --non-interactive install nodejs npm
      ;;
    *)
      err "Unsupported package manager for auto Node.js install."
      exit 1
      ;;
  esac

  major="$(node_major_version)"
  if [[ "$major" -lt 20 ]]; then
    err "Node.js installation failed to reach >=20."
    exit 1
  fi

  ok "Node.js installed successfully."
}

ensure_redis_running() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found. Ensure Redis is running manually."
    return
  fi

  info "Ensuring Redis service is active..."
  if ${SUDO} systemctl enable --now redis-server.service >/dev/null 2>&1; then
    ok "Redis active: redis-server.service"
    return
  fi
  if ${SUDO} systemctl enable --now redis.service >/dev/null 2>&1; then
    ok "Redis active: redis.service"
    return
  fi

  warn "Could not auto-start Redis service. Check REDIS_URL in .env"
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
  date +%s%N | sha256sum | cut -d' ' -f1
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
    ${SUDO} chown "$SERVICE_USER:$SERVICE_GROUP" "$env_path" || true
    ${SUDO} chmod 640 "$env_path" || true
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

  if command -v ss >/dev/null 2>&1; then
    if ss -ltn | awk '{print $4}' | grep -E "(^|:)${port}$" >/dev/null 2>&1; then
      warn "$label port seems busy: $port"
      return
    fi
    ok "$label port available: $port"
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

  warn "Could not verify port availability (ss/lsof missing)."
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

  chmod +x "$APP_DIR/install.sh" "$APP_DIR/updater.sh" || true

  if [[ "$(id -un)" != "$SERVICE_USER" ]]; then
    ${SUDO} chown -R "$SERVICE_USER:$SERVICE_GROUP" \
      "$APP_DIR/data" "$APP_DIR/run" "$APP_DIR/logs" || true
    ${SUDO} chown "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR/updater.sh" || true
  fi

  ok "Runtime directories ready."
}

run_as_service_user() {
  local cmd="$1"

  if [[ "$(id -un)" == "$SERVICE_USER" ]]; then
    bash -lc "$cmd"
    return
  fi

  if [[ -n "$SUDO" ]]; then
    ${SUDO} -u "$SERVICE_USER" -H bash -lc "$cmd"
    return
  fi

  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- bash -lc "$cmd"
    return
  fi

  if command -v su >/dev/null 2>&1; then
    su -s /bin/bash "$SERVICE_USER" -c "$cmd"
    return
  fi

  err "Cannot switch user to $SERVICE_USER"
  exit 1
}

run_npm_install() {
  if [[ "$SKIP_NPM_INSTALL" == "true" ]]; then
    warn "Skipping npm install by request."
    return
  fi

  info "Installing npm dependencies..."
  run_as_service_user "cd '$APP_DIR' && npm install --omit=dev"
  ok "npm install completed."
}

run_syntax_checks() {
  info "Running syntax checks..."
  run_as_service_user "cd '$APP_DIR' && node --check '$CORE_ENTRY'"
  run_as_service_user "cd '$APP_DIR' && node --check '$WEB_ENTRY'"
  ok "Syntax checks passed."
}

create_core_service() {
  local service_file="/etc/systemd/system/${CORE_SERVICE_NAME}.service"

  ${SUDO} tee "$service_file" >/dev/null <<EOF
[Unit]
Description=mailFastApi Core API Service
After=network.target redis-server.service redis.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${APP_DIR}/${ENV_FILE}
ExecStart=/usr/bin/env node ${CORE_ENTRY}
Restart=always
RestartSec=3
LimitNOFILE=65535
StandardOutput=append:${APP_DIR}/logs/core/systemd.out.log
StandardError=append:${APP_DIR}/logs/core/systemd.err.log

[Install]
WantedBy=multi-user.target
EOF
}

create_web_service() {
  local service_file="/etc/systemd/system/${WEB_SERVICE_NAME}.service"

  ${SUDO} tee "$service_file" >/dev/null <<EOF
[Unit]
Description=mailFastApi Web Panel Service
After=network.target ${CORE_SERVICE_NAME}.service
Wants=network-online.target ${CORE_SERVICE_NAME}.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${APP_DIR}/${ENV_FILE}
ExecStart=/usr/bin/env node ${WEB_ENTRY}
Restart=always
RestartSec=3
LimitNOFILE=65535
StandardOutput=append:${APP_DIR}/logs/web/systemd.out.log
StandardError=append:${APP_DIR}/logs/web/systemd.err.log

[Install]
WantedBy=multi-user.target
EOF
}

setup_systemd_services() {
  if [[ "$SKIP_SERVICE_SETUP" == "true" ]]; then
    warn "Skipping service setup by request."
    return
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl is not available. Cannot auto-create services."
    return
  fi

  info "Creating systemd service units..."
  create_core_service
  create_web_service

  ${SUDO} systemctl daemon-reload
  ${SUDO} systemctl enable --now "${CORE_SERVICE_NAME}.service"
  ${SUDO} systemctl enable --now "${WEB_SERVICE_NAME}.service"

  ok "Services enabled and started: ${CORE_SERVICE_NAME}, ${WEB_SERVICE_NAME}"
}

print_post_install() {
  local port web_port
  port="$(get_env_value "PORT" "3000")"
  web_port="$(get_env_value "WEB_PORT" "3300")"

  echo ""
  ok "Installation completed."
  echo -e "${CYAN}Core Service${RESET}: ${CORE_SERVICE_NAME}.service"
  echo -e "${CYAN}Web Service${RESET} : ${WEB_SERVICE_NAME}.service"
  echo -e "${CYAN}App Dir${RESET}     : ${APP_DIR}"
  echo -e "${CYAN}Env File${RESET}    : ${APP_DIR}/${ENV_FILE}"
  echo ""
  echo "URLs (default):"
  echo "  Core Health : http://127.0.0.1:${port}/health"
  echo "  Web Monitor : http://127.0.0.1:${web_port}/monitor"
  echo ""
  echo "Useful commands:"
  echo "  sudo systemctl status ${CORE_SERVICE_NAME}"
  echo "  sudo systemctl status ${WEB_SERVICE_NAME}"
  echo "  sudo journalctl -u ${CORE_SERVICE_NAME} -f"
  echo "  sudo journalctl -u ${WEB_SERVICE_NAME} -f"
  echo "  ./updater.sh"
  echo ""
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

  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    err "Service user does not exist: $SERVICE_USER"
    exit 1
  fi
  SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

  if [[ "$SKIP_SYSTEM_DEPS" != "true" ]]; then
    install_system_dependencies
    install_node_lts_if_needed
    ensure_redis_running
  else
    warn "Skipping system dependencies by request."
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
  setup_systemd_services
  print_post_install
}

main "$@"
