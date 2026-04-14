#!/usr/bin/env bash
set -euo pipefail

# mailFastApi Linux installer
# - Installs required system dependencies
# - Ensures Node.js LTS (>=20)
# - Ensures Redis is installed/running
# - Installs npm packages
# - Creates/enables systemd service

SERVICE_NAME="mailfastapi"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_SYSTEM_DEPS="false"
SKIP_SERVICE_SETUP="false"
SERVICE_USER_DEFAULT="${SUDO_USER:-$USER}"
SERVICE_USER="$SERVICE_USER_DEFAULT"
SERVICE_GROUP=""
ENV_TEMPLATE_FILE=".env.example"
ENV_FILE=".env"
SHOULD_CONFIGURE_ENV="false"
PROMPT_RESULT=""

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
    echo -e "${RED}[ERROR]${RESET} sudo is required to install dependencies and create systemd service."
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
  echo -e "${RESET}${MAGENTA}Linux Auto Installer${RESET}"
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
  --service-name <name>   systemd service name (default: ${SERVICE_NAME})
  --service-user <user>   user to run service as (default: ${SERVICE_USER_DEFAULT})
  --app-dir <path>        project directory to run as service (default: script directory)
  --skip-system-deps      skip apt/dnf/yum/pacman/zypper installs
  --skip-service          skip systemd unit creation/enable
  -h, --help              show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-name)
      SERVICE_NAME="$2"
      shift 2
      ;;
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

if [[ ! -d "${APP_DIR}" ]]; then
  err "APP_DIR does not exist: ${APP_DIR}"
  exit 1
fi

APP_DIR="$(cd "${APP_DIR}" && pwd)"

if [[ "$OSTYPE" != "linux-gnu"* ]] && [[ "$(uname -s)" != "Linux" ]]; then
  err "This installer is intended for Linux systems."
  exit 1
fi

if [[ ! -f "${APP_DIR}/package.json" ]]; then
  err "package.json not found in APP_DIR: ${APP_DIR}"
  exit 1
fi

if [[ ! -f "${APP_DIR}/src/app.js" ]]; then
  err "src/app.js not found in APP_DIR: ${APP_DIR}"
  exit 1
fi

detect_pkg_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    echo "apt"
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    echo "dnf"
    return
  fi
  if command -v yum >/dev/null 2>&1; then
    echo "yum"
    return
  fi
  if command -v pacman >/dev/null 2>&1; then
    echo "pacman"
    return
  fi
  if command -v zypper >/dev/null 2>&1; then
    echo "zypper"
    return
  fi
  echo ""
}

PKG_MANAGER="$(detect_pkg_manager)"

install_system_dependencies() {
  if [[ -z "${PKG_MANAGER}" ]]; then
    warn "No supported package manager detected. Skipping system dependency install."
    return
  fi

  info "Installing system dependencies via ${PKG_MANAGER}..."
  case "${PKG_MANAGER}" in
    apt)
      ${SUDO} apt-get update -y
      ${SUDO} apt-get install -y \
        curl ca-certificates gnupg lsb-release git build-essential sqlite3 redis-server
      ;;
    dnf)
      ${SUDO} dnf install -y \
        curl ca-certificates gnupg2 git gcc-c++ make sqlite redis
      ;;
    yum)
      ${SUDO} yum install -y \
        curl ca-certificates gnupg2 git gcc-c++ make sqlite redis
      ;;
    pacman)
      ${SUDO} pacman -Sy --noconfirm --needed \
        curl ca-certificates gnupg git base-devel sqlite redis
      ;;
    zypper)
      ${SUDO} zypper --non-interactive install \
        curl ca-certificates gpg2 git gcc-c++ make sqlite3 redis
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
  if [[ "${major}" -ge 20 ]]; then
    ok "Node.js version is already suitable (>=20)."
    return
  fi

  info "Node.js >=20 not found, installing Node.js LTS..."
  case "${PKG_MANAGER}" in
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
      err "Unsupported package manager for automatic Node.js install."
      err "Please install Node.js >=20 manually and re-run this script."
      exit 1
      ;;
  esac

  major="$(node_major_version)"
  if [[ "${major}" -lt 20 ]]; then
    err "Node.js installation did not result in version >=20."
    exit 1
  fi
  ok "Node.js installed successfully."
}

ensure_redis_running() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found. Skipping Redis service auto-start."
    warn "Please ensure Redis is reachable from REDIS_URL."
    return
  fi

  info "Ensuring Redis service is enabled and running..."
  local redis_service=""
  for redis_service in redis-server redis; do
    if ${SUDO} systemctl enable --now "${redis_service}.service" >/dev/null 2>&1; then
      ok "Redis service active: ${redis_service}.service"
      return
    fi
  done

  warn "Redis systemd unit not found or could not be started automatically."
  warn "Please ensure Redis is running and update REDIS_URL in .env if needed."
}

is_secret_key() {
  local key="$1"
  case "${key}" in
    SMTP_PASS|JWT_SECRET|AUTH_CLIENT_SECRET|API_KEY)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

has_interactive_tty() {
  [[ -r /dev/tty ]] && [[ -w /dev/tty ]]
}

env_value_from_existing() {
  local key="$1"
  local fallback="$2"
  local env_path="${APP_DIR}/${ENV_FILE}"
  local existing_line=""

  if [[ -f "${env_path}" ]]; then
    existing_line="$(grep -E "^${key}=" "${env_path}" | tail -n 1 || true)"
  fi

  if [[ -n "${existing_line}" ]]; then
    echo "${existing_line#*=}"
  else
    echo "${fallback}"
  fi
}

prompt_env_value() {
  local key="$1"
  local default_value="$2"
  local input_value=""
  local prompt_label=""

  prompt_label="$(env_prompt_label "${key}")"

  if ! has_interactive_tty; then
    PROMPT_RESULT="${default_value}"
    return
  fi

  if is_secret_key "${key}"; then
    if [[ -n "${default_value}" ]]; then
      printf "%s" "${prompt_label} [varsayilan: gizli, Enter mevcutu korur]: " > /dev/tty
      read -r -s input_value < /dev/tty
    else
      printf "%s" "${prompt_label} [varsayilan: bos]: " > /dev/tty
      read -r -s input_value < /dev/tty
    fi
    printf '\n' > /dev/tty
  else
    if [[ -n "${default_value}" ]]; then
      printf "%s" "${prompt_label} [varsayilan: ${default_value}]: " > /dev/tty
      read -r input_value < /dev/tty
    else
      printf "%s" "${prompt_label} [varsayilan: bos]: " > /dev/tty
      read -r input_value < /dev/tty
    fi
  fi

  if [[ -z "${input_value}" ]]; then
    PROMPT_RESULT="${default_value}"
  else
    PROMPT_RESULT="${input_value}"
  fi
}

env_prompt_label() {
  local key="$1"
  case "${key}" in
    SMTP_HOST) echo "SMTP mail server adresi (or. smtp.gmail.com)" ;;
    SMTP_PORT) echo "SMTP portu (genelde 587 veya 465)" ;;
    SMTP_USER) echo "SMTP kullanici adi / e-posta adresi" ;;
    SMTP_PASS) echo "SMTP sifresi / uygulama sifresi" ;;
    SMTP_SECURE) echo "SMTP secure degeri (true/false)" ;;
    SMTP_MAX_CONNECTIONS) echo "SMTP havuz max baglanti sayisi" ;;
    SMTP_MAX_MESSAGES) echo "Baglanti basi max mesaj sayisi" ;;
    SMTP_RATE_LIMIT) echo "SMTP rate limit (pencere icindeki max mesaj)" ;;
    SMTP_RATE_DELTA) echo "SMTP rate delta (ms)" ;;
    PORT) echo "API portu" ;;
    MAIL_FROM) echo "Gonderici adresi (MAIL_FROM)" ;;
    AUTH_MODE) echo "Kimlik dogrulama modu (jwt/api_key/none)" ;;
    JWT_SECRET) echo "JWT secret anahtari" ;;
    JWT_ISSUER) echo "JWT issuer" ;;
    JWT_AUDIENCE) echo "JWT audience" ;;
    JWT_EXPIRES_IN) echo "JWT suresi (or. 5m, 1h)" ;;
    AUTH_CLIENT_ID) echo "JWT istemci kimligi (client id)" ;;
    AUTH_CLIENT_SECRET) echo "JWT istemci gizli anahtari (client secret)" ;;
    JWT_CLIENTS_JSON) echo "Coklu JWT istemci JSON (opsiyonel)" ;;
    TOKEN_RATE_LIMIT_WINDOW_MS) echo "Token endpoint rate limit penceresi (ms)" ;;
    TOKEN_RATE_LIMIT_MAX) echo "Token endpoint max istek sayisi" ;;
    API_KEY) echo "API key degeri (AUTH_MODE=api_key icin)" ;;
    RATE_LIMIT_WINDOW_MS) echo "Global API rate limit penceresi (ms)" ;;
    RATE_LIMIT_MAX) echo "Global API max istek sayisi" ;;
    QUEUE_BACKEND) echo "Kuyruk backend'i (redis/memory)" ;;
    QUEUE_MAX_SIZE) echo "In-memory kuyruk max boyutu" ;;
    WORKER_CONCURRENCY) echo "Paralel worker sayisi" ;;
    RETRY_ATTEMPTS) echo "Mail gonderim retry deneme sayisi" ;;
    RETRY_DELAY_MS) echo "Retry gecikmesi (ms)" ;;
    SHUTDOWN_TIMEOUT_MS) echo "Graceful shutdown timeout (ms)" ;;
    REDIS_URL) echo "Redis baglanti adresi (URL)" ;;
    REDIS_QUEUE_KEY) echo "Redis kuyruk anahtari (key)" ;;
    REDIS_COMMAND_TIMEOUT_MS) echo "Redis komut timeout (ms)" ;;
    LOG_DB_PATH) echo "SQLite log veritabani yolu" ;;
    LOG_DIR) echo "Log klasoru" ;;
    LOG_FILE_NAME) echo "Log dosya adi" ;;
    LOG_FLUSH_INTERVAL_MS) echo "Log flush araligi (ms)" ;;
    TEST_MAIL_TO) echo "Test mail alicisi (npm test mailsend icin)" ;;
    *) echo "${key}" ;;
  esac
}

ask_env_configuration_preference() {
  local choice=""

  if ! has_interactive_tty; then
    SHOULD_CONFIGURE_ENV="false"
    warn "Non-interactive shell detected. Skipping interactive .env editing."
    return
  fi

  printf "%s" ".env dosyasini simdi duzenlemek ister misiniz? [y/N]: " > /dev/tty
  read -r choice < /dev/tty
  case "${choice}" in
    y|Y|yes|YES|Yes|e|E|evet|EVET|Evet)
      SHOULD_CONFIGURE_ENV="true"
      ;;
    *)
      SHOULD_CONFIGURE_ENV="false"
      ;;
  esac
}

ensure_env_file_without_prompt() {
  local template_path="${APP_DIR}/${ENV_TEMPLATE_FILE}"
  local env_path="${APP_DIR}/${ENV_FILE}"

  if [[ -f "${env_path}" ]]; then
    info ".env already exists, skipping interactive edit as requested."
    return
  fi

  if [[ ! -f "${template_path}" ]]; then
    err "${ENV_TEMPLATE_FILE} is missing in ${APP_DIR}"
    exit 1
  fi

  cp "${template_path}" "${env_path}"

  if [[ "$(id -un)" != "${SERVICE_USER}" ]]; then
    ${SUDO} chown "${SERVICE_USER}:${SERVICE_GROUP}" "${env_path}" || true
    ${SUDO} chmod 640 "${env_path}" || true
  else
    chmod 600 "${env_path}" || true
  fi

  warn ".env created from ${ENV_TEMPLATE_FILE} with default values."
  warn "You can edit ${env_path} later if needed."
}

configure_env_file() {
  local template_path="${APP_DIR}/${ENV_TEMPLATE_FILE}"
  local env_path="${APP_DIR}/${ENV_FILE}"
  local tmp_path="${env_path}.tmp"
  local line=""
  local key=""
  local template_default=""
  local effective_default=""
  local final_value=""

  if [[ ! -f "${template_path}" ]]; then
    err "${ENV_TEMPLATE_FILE} is missing in ${APP_DIR}"
    exit 1
  fi

  if [[ -f "${env_path}" ]] && has_interactive_tty; then
    local overwrite_choice=""
    printf "%s" ".env already exists. Reconfigure from ${ENV_TEMPLATE_FILE}? [Y/n]: " > /dev/tty
    read -r overwrite_choice < /dev/tty
    if [[ "${overwrite_choice}" =~ ^[Nn]$ ]]; then
      info "Keeping existing .env file."
      return
    fi
  fi

  if ! has_interactive_tty; then
    warn "Non-interactive shell detected. .env will be generated with defaults from ${ENV_TEMPLATE_FILE}."
  else
    info "Configuring .env from ${ENV_TEMPLATE_FILE} (press Enter to accept defaults)."
  fi

  : > "${tmp_path}"

  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ -z "${line}" ]] || [[ "${line}" =~ ^[[:space:]]*# ]]; then
      printf '%s\n' "${line}" >> "${tmp_path}"
      continue
    fi

    if [[ "${line}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      key="${line%%=*}"
      template_default="${line#*=}"
      effective_default="$(env_value_from_existing "${key}" "${template_default}")"
      prompt_env_value "${key}" "${effective_default}"
      final_value="${PROMPT_RESULT}"
      printf '%s=%s\n' "${key}" "${final_value}" >> "${tmp_path}"
      continue
    fi

    printf '%s\n' "${line}" >> "${tmp_path}"
  done < "${template_path}"

  mv "${tmp_path}" "${env_path}"

  if [[ "$(id -un)" != "${SERVICE_USER}" ]]; then
    ${SUDO} chown "${SERVICE_USER}:${SERVICE_GROUP}" "${env_path}" || true
    ${SUDO} chmod 640 "${env_path}" || true
  else
    chmod 600 "${env_path}" || true
  fi

  ok ".env is ready at ${env_path}"
}

run_as_service_user() {
  local cmd="$1"

  if [[ "$(id -un)" == "${SERVICE_USER}" ]]; then
    bash -lc "${cmd}"
    return
  fi

  if [[ -n "${SUDO}" ]]; then
    ${SUDO} -u "${SERVICE_USER}" -H bash -lc "${cmd}"
    return
  fi

  if command -v runuser >/dev/null 2>&1; then
    runuser -u "${SERVICE_USER}" -- bash -lc "${cmd}"
    return
  fi

  if command -v su >/dev/null 2>&1; then
    su -s /bin/bash "${SERVICE_USER}" -c "${cmd}"
    return
  fi

  err "Cannot switch to service user ${SERVICE_USER}. sudo/runuser/su not available."
  exit 1
}

run_npm_install() {
  info "Installing Node.js dependencies (npm install)..."
  run_as_service_user "cd '${APP_DIR}' && npm install"

  ok "npm dependencies installed."
}

create_runtime_dirs() {
  mkdir -p "${APP_DIR}/logs" "${APP_DIR}/data"
  if [[ "$(id -un)" != "${SERVICE_USER}" ]]; then
    ${SUDO} chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "${APP_DIR}/logs" "${APP_DIR}/data" || true
  fi
}

create_systemd_service() {
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
  local redis_after_units="redis-server.service redis.service"

  info "Creating systemd service: ${SERVICE_NAME}.service"
  ${SUDO} tee "${service_file}" >/dev/null <<EOF
[Unit]
Description=mailFastApi Node.js Mail Microservice
After=network.target ${redis_after_units}
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/env node src/app.js
Restart=always
RestartSec=3
LimitNOFILE=65535
StandardOutput=append:${APP_DIR}/logs/systemd.out.log
StandardError=append:${APP_DIR}/logs/systemd.err.log

[Install]
WantedBy=multi-user.target
EOF

  ${SUDO} systemctl daemon-reload || warn "systemctl daemon-reload failed (expected in WSL without systemd)"
  ${SUDO} systemctl enable --now "${SERVICE_NAME}.service" || warn "systemctl enable failed (expected in WSL without systemd)"
  ok "Service configuration completed: ${SERVICE_NAME}.service"
}

print_post_install() {
  echo ""
  ok "Installation completed."
  echo -e "${CYAN}Service${RESET}: ${SERVICE_NAME}.service"
  echo -e "${CYAN}App Dir${RESET}: ${APP_DIR}"
  echo -e "${CYAN}Env File${RESET}: ${APP_DIR}/.env"
  echo ""
  echo "Useful commands:"
  echo "  sudo systemctl status ${SERVICE_NAME}"
  echo "  sudo journalctl -u ${SERVICE_NAME} -f"
  echo "  npm run log:mailsender"
  echo ""
  warn "Verify .env SMTP values and JWT secrets for production."
}

main() {
  print_banner

  info "Service name      : ${SERVICE_NAME}"
  info "Service user      : ${SERVICE_USER}"
  info "Application dir   : ${APP_DIR}"
  info "Skip system deps  : ${SKIP_SYSTEM_DEPS}"
  info "Skip service setup: ${SKIP_SERVICE_SETUP}"
  echo ""

  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    err "Service user does not exist: ${SERVICE_USER}"
    exit 1
  fi
  SERVICE_GROUP="$(id -gn "${SERVICE_USER}")"

  ask_env_configuration_preference
  if [[ "${SHOULD_CONFIGURE_ENV}" == "true" ]]; then
    configure_env_file
  else
    ensure_env_file_without_prompt
  fi

  if [[ "${SKIP_SYSTEM_DEPS}" != "true" ]]; then
    install_system_dependencies
    install_node_lts_if_needed
    ensure_redis_running
  else
    warn "Skipping system dependency installation by request."
  fi

  create_runtime_dirs
  run_npm_install

  if [[ "${SKIP_SERVICE_SETUP}" != "true" ]]; then
    if ! command -v systemctl >/dev/null 2>&1; then
      warn "systemctl is not available. Cannot create Linux service automatically (Expected in WSL)."
    else
      create_systemd_service
    fi
  else
    warn "Skipping systemd service setup by request."
  fi

  print_post_install
}

main "$@"
