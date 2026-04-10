# Envanter Operasyon Merkezi

Internal web app for building inventory handoff emails from device lists, component lookups, and OCR-assisted label capture.

The app runs as a small Express server with a SQLite database, serves a login screen plus editor UI, and can call an OpenAI-compatible OCR endpoint to read hardware labels from camera or gallery images.

## Features

- User picker login backed by seeded local users
- Draft-based workflow for creating and reopening inventory mail sessions
- Device and component editor with live email preview
- Inventory search against bundled asset and component datasets
- OCR flow for disks, RAM, NICs, CPUs, and short server labels
- Automatic self-signed HTTPS certificate generation on first run
- Local SQLite persistence for sessions and imported inventory data

## Stack

- Node.js + Express
- SQLite via `better-sqlite3`
- Static frontend in `public/`
- OCR through an OpenAI-compatible chat completions API

## Requirements

- Node.js 18+ recommended
- `npm`
- `openssl` available on the machine for first-run certificate generation
- Network access to your configured OCR provider if you want OCR enabled

## Quick Start

```bash
cd /root/inventory-mail-generator
cp .env.example .env
npm install
npm run dev
```

Open:

- `https://localhost:3000`
- `http://localhost:3001`

The server listens on `PORT` for HTTPS and `PORT + 1` for HTTP.

## Run as a Service

If you want the app to keep running after you close the shell, use the bundled `systemd` service workflow.

`setup.sh` is the main installer. It:

- Installs runtime packages (`nodejs`, `npm`, `openssl`, etc.).
- Runs `npm install`.
- Installs/updates the `inventory-mail-generator` systemd service (unless skipped).

Install/update with defaults:

```bash
cd /root/inventory-mail-generator
sudo bash ./setup.sh
```

Common setup flags:

```bash
# Enable service at boot
sudo bash ./setup.sh --enable-web

# Replace /etc/default/inventory-mail-generator from repo defaults
sudo bash ./setup.sh --reset-web-env

# Install dependencies only (skip systemd service step)
sudo bash ./setup.sh --skip-web-service
```

If dependencies are already installed and you only want to refresh service files:

```bash
cd /root/inventory-mail-generator
sudo bash ./install_web_service.sh
```

`install_web_service.sh` flags:

```bash
# Enable service at boot
sudo bash ./install_web_service.sh --enable

# Disable service at boot
sudo bash ./install_web_service.sh --disable

# Replace /etc/default/inventory-mail-generator from repo defaults
sudo bash ./install_web_service.sh --reset-env

# Update files without restarting the service
sudo bash ./install_web_service.sh --no-restart
```

Service installer behavior:

- Installs unit file to `/etc/systemd/system/inventory-mail-generator.service`.
- Installs env file to `/etc/default/inventory-mail-generator` if missing (or when `--reset-env` is used).
- Rewrites `WorkingDirectory` and `ExecStart` in the installed unit to match the current repo path.
- Runs a runner preflight (`run_web_service.sh --help`) before touching systemd files.

Useful service commands:

```bash
sudo systemctl start inventory-mail-generator
sudo systemctl stop inventory-mail-generator
sudo systemctl restart inventory-mail-generator
sudo systemctl status inventory-mail-generator
sudo journalctl -u inventory-mail-generator -f
```

Run without systemd (foreground):

```bash
cd /root/inventory-mail-generator
sudo bash ./run_web_service.sh
```

Runner overrides:

```bash
# Change HTTPS port (HTTP always uses PORT + 1)
sudo PORT=3100 bash ./run_web_service.sh
sudo bash ./run_web_service.sh --port 3100

# Use a custom Node binary
sudo NODE_BIN=/usr/bin/node bash ./run_web_service.sh
```

## Environment Variables

Create `.env` from `.env.example` and fill in real values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTPS port. Defaults to `3000`. |
| `AI_API_URL` | Yes for OCR | OpenAI-compatible multimodal chat completions endpoint. |
| `AI_API_KEY` | Yes for OCR | Primary Gemini/compatible API key (used after fallback keys). |
| `AI_API_KEYS` | No | Comma-separated fallback keys. The app rotates keys on `429` responses. |
| `AI_MODEL` | No | Model name sent to the provider. Defaults to `gemini-2.5-flash`. |

If no OCR keys are configured, the app still starts, but OCR requests will fail until the variables are set.

For service mode, `PORT` can also be set in `/etc/default/inventory-mail-generator`.
Values already exported by systemd environment files are not overridden by `.env`.

## Data and Storage

On startup the app will:

1. Create `db/inventory.db` if it does not exist.
2. Create the required tables for users, sessions, devices, components, and units.
3. Seed the local user list.
4. Import inventory data from `data/assets_all.json` and `data/components_all.json` if the inventory tables are empty.
5. Generate `certs/key.pem` and `certs/cert.pem` if no local certificate exists yet.

These generated paths are already ignored by Git:

- `db/`
- `certs/`
- `.env`
- `node_modules/`
- `backups/`

## Authentication Notes

- Login is handled by selecting a seeded username from the landing page.
- Session state is stored in memory, and the browser receives a cookie.
- Restarting the Node process clears active sessions, so users will need to log in again.
- This setup is fine for an internal tool, but it is not production-grade authentication.

Seeded users are currently:

- `bahadir`
- `anil`
- `eren`
- `emre`
- `yagiz`
- `volkan`

## Branch Workflow

This repo follows the same lightweight branch setup as `diskmanager`:

- `main` for the stable branch on GitHub
- `dev` for active work

Current local tracking is set up so:

- `main` tracks `origin/main`
- `dev` tracks `origin/dev`

Typical flow:

```bash
git checkout dev
# make changes
git add .
git commit -m "Describe the change"
git push

git checkout main
git merge dev
git push
```

## Project Layout

```text
inventory-mail-generator/
├── data/           # Seed inventory JSON files
├── middleware/     # Auth middleware and in-memory session checks
├── public/         # Login page, app UI, CSS, and browser scripts
├── routes/         # Auth, sessions, inventory search, OCR APIs
├── db.js           # SQLite bootstrap and seed/import logic
├── generate-cert.js
├── server.js
└── .env.example
```

## Useful Commands

```bash
# Start in watch mode
npm run dev

# Start without watch mode
npm start

# Install/update the service
sudo bash ./setup.sh

# Enable service on boot
sudo bash ./setup.sh --enable-web

# Refresh only systemd service files
sudo bash ./install_web_service.sh
```

## Notes

- The repo includes the bundled inventory seed files but does not include the live SQLite database.
- The repo does not include generated TLS certs.
- OCR uses an OpenAI-compatible multimodal endpoint (Gemini supported).
