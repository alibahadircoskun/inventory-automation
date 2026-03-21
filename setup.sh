#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: setup.sh [--enable-web] [--reset-web-env] [--skip-web-service] [--help]

Installs runtime dependencies, installs Node packages, and optionally
installs the systemd service for Inventory Mail Generator.

Options:
  --enable-web       Enable inventory-mail-generator at boot.
  --reset-web-env    Replace /etc/default/inventory-mail-generator from repo defaults.
  --skip-web-service Skip systemd web service install step.
  --help             Show this help text.
EOF
}

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root." >&2
    exit 1
fi

ENABLE_WEB=0
RESET_WEB_ENV=0
SKIP_WEB_SERVICE=0

for arg in "$@"; do
    case "$arg" in
        --enable-web)
            ENABLE_WEB=1
            ;;
        --reset-web-env)
            RESET_WEB_ENV=1
            ;;
        --skip-web-service)
            SKIP_WEB_SERVICE=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            usage >&2
            exit 1
            ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_JSON="${SCRIPT_DIR}/package.json"
INSTALL_WEB_SH="${SCRIPT_DIR}/install_web_service.sh"
RUN_WEB_SH="${SCRIPT_DIR}/run_web_service.sh"

if [ ! -f "${PACKAGE_JSON}" ]; then
    echo "Expected package.json not found: ${PACKAGE_JSON}" >&2
    echo "Run setup.sh from inside the inventory-mail-generator repo." >&2
    exit 1
fi

echo "Installing system dependencies for Inventory Mail Generator..."

apt-get update -qq
apt-get install -y -qq \
    ca-certificates \
    nodejs \
    npm \
    openssl

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js is not installed or not on PATH after apt install." >&2
    exit 1
fi

if ! node -e "const major=Number(process.versions.node.split('.')[0]); if (!Number.isFinite(major) || major < 18) process.exit(1)"; then
    echo "Node.js 18+ is required. Installed version is: $(node -v 2>/dev/null || echo unknown)" >&2
    echo "Install a newer Node.js release, then rerun setup.sh." >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed or not on PATH after apt install." >&2
    exit 1
fi

chmod +x "${RUN_WEB_SH}" "${INSTALL_WEB_SH}" "${SCRIPT_DIR}/setup.sh"

echo "Installing Node.js dependencies..."
cd "${SCRIPT_DIR}"
npm install

if [ "${SKIP_WEB_SERVICE}" -eq 1 ]; then
    echo "Skipping web service install (--skip-web-service)."
elif [ -f "${INSTALL_WEB_SH}" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    echo "Installing/updating inventory-mail-generator service..."
    web_args=()
    if [ "${ENABLE_WEB}" -eq 1 ]; then
        web_args+=(--enable)
    fi
    if [ "${RESET_WEB_ENV}" -eq 1 ]; then
        web_args+=(--reset-env)
    fi
    bash "${INSTALL_WEB_SH}" "${web_args[@]}"
else
    echo "Warning: service installer or active systemd missing. Skipping web service install."
fi

echo "Done."
echo "- Run 'bash ./run_web_service.sh' to start manually."
echo "- Use 'systemctl status inventory-mail-generator' for service status."
echo "- Optional boot autostart: systemctl enable inventory-mail-generator"
