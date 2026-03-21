#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PATH="${SCRIPT_DIR}/server.js"
CERT_KEY="${SCRIPT_DIR}/certs/key.pem"
CERT_CERT="${SCRIPT_DIR}/certs/cert.pem"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"

usage() {
    cat <<'EOF'
Usage: run_web_service.sh [--port PORT] [--help]

Environment overrides:
  PORT      HTTPS port to bind. Defaults to 3000.
  NODE_BIN  Defaults to /usr/bin/node
EOF
}

if [ "$(id -u)" -ne 0 ]; then
    echo "This script must be run as root." >&2
    exit 1
fi

PORT="${PORT:-3000}"

while [ $# -gt 0 ]; do
    case "$1" in
        --port)
            [ $# -ge 2 ] || { echo "Missing value for --port" >&2; exit 1; }
            PORT="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo "Invalid port '${PORT}'. Expected an integer in [1, 65535]." >&2
    exit 1
fi

if [ ! -f "$APP_PATH" ]; then
    echo "Missing app entrypoint: $APP_PATH" >&2
    exit 1
fi

if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "Node.js binary not found: ${NODE_BIN}" >&2
    exit 1
fi

if ! "$NODE_BIN" -e "const major=Number(process.versions.node.split('.')[0]); if (!Number.isFinite(major) || major < 18) process.exit(1)"; then
    echo "Node.js 18+ is required to run this app." >&2
    exit 1
fi

if ! "$NODE_BIN" -e "require('express'); require('better-sqlite3'); require('cookie-parser')" >/dev/null 2>&1; then
    echo "Missing Node.js dependencies. Run: npm install" >&2
    exit 1
fi

if { [ ! -f "$CERT_KEY" ] || [ ! -f "$CERT_CERT" ]; } && ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate the self-signed certificate on first run." >&2
    exit 1
fi

cd "$SCRIPT_DIR"

echo "Starting Inventory Mail Generator on HTTPS port ${PORT} (HTTP $((PORT + 1))) ..."
export PORT
exec "$NODE_BIN" "$APP_PATH"
