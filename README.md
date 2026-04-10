# Inventory Automation

Internal web app for managing hardware inventory handoffs, Snipe-IT synchronisation, and approval workflows. Built on top of the original `inventory-mail-generator` and extended into a full inventory automation platform.

The app runs as a small Express server with a SQLite database, serves a login screen plus editor UI, and integrates with a local Snipe-IT instance for asset and component tracking.

## Features

- User picker login with role-based access (technician / manager)
- Draft-based workflow for creating, reviewing, and approving inventory sessions
- Approval flow: managers review technician sessions and sync changes to Snipe-IT
- Snipe-IT integration — assets and components are read from and written back to a live Snipe-IT instance
- Snipe-IT sync revert: approved sessions can be undone
- Device and component editor with live email preview
- Inventory search against bundled asset and component datasets
- OCR flow for disks, RAM, NICs, CPUs, and short server labels
- In-app notifications for session approvals and rejections
- Current device state snapshots captured at session creation
- Python scripts for bulk-importing component batches into Snipe-IT
- Automatic self-signed HTTPS certificate generation on first run
- Local SQLite persistence for sessions, events, and imported inventory data

## Stack

- Node.js + Express
- SQLite via `better-sqlite3`
- Static frontend in `public/`
- OCR through an OpenAI-compatible chat completions API (Gemini supported)
- Snipe-IT REST API for asset/component sync

## Requirements

- Node.js 18+ recommended
- `npm`
- `openssl` available on the machine for first-run certificate generation
- Network access to your Snipe-IT instance
- Network access to your configured OCR provider if you want OCR enabled

## Quick Start

```bash
cd /root/inventory-mail-generator
cp .env.example .env
# fill in SNIPEIT_API_URL, SNIPEIT_API_TOKEN, and AI_API_KEY in .env
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
- Installs/updates the `inventory-automation` systemd service (unless skipped).

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
| `SNIPEIT_API_URL` | Yes | Base URL for the Snipe-IT API (e.g. `http://127.0.0.1:8000/api/v1`). |
| `SNIPEIT_API_TOKEN` | Yes | Snipe-IT API token. In local dev the app can fall back to the token file at `/opt/snipeit/.automation-api-token`. |
| `SNIPEIT_TIMEOUT_MS` | No | HTTP timeout for Snipe-IT requests. Defaults to `60000`. |
| `SNIPEIT_DRY_RUN` | No | Set to `true` to skip all write operations to Snipe-IT. |

If no OCR keys are configured, the app still starts but OCR requests will fail until the variables are set.
If Snipe-IT variables are missing in local development, the app attempts to read the token from `/opt/snipeit/.automation-api-token`.

For service mode, `PORT` can also be set in `/etc/default/inventory-mail-generator`.
Values already exported by systemd environment files are not overridden by `.env`.

## Data and Storage

On startup the app will:

1. Create `db/inventory.db` if it does not exist.
2. Create the required tables for users, sessions, devices, components, units, events, and notifications.
3. Seed the local user list.
4. Import inventory data from `data/assets_all.json` and `data/components_all.json` if the inventory tables are empty.
5. Generate `certs/key.pem` and `certs/cert.pem` if no local certificate exists yet.

These generated paths are already ignored by Git:

- `db/`
- `certs/`
- `.env`
- `node_modules/`
- `backups/`

## Authentication and Roles

- Login is handled by selecting a seeded username and entering a PIN from the landing page.
- Two roles are supported: `technician` (default) and `manager`.
- Managers can access the approval queue and sync sessions to Snipe-IT.
- Session state is stored in memory; restarting the Node process clears active sessions.

Seeded users:

- `bahadir` — manager
- `anil`
- `eren`
- `emre`
- `yagiz`
- `volkan`

To bootstrap admin credentials on a fresh instance:

```bash
npm run bootstrap-auth
```

## Approval Workflow

1. A technician creates a session, edits devices and components, and submits it for review.
2. A manager opens the approval queue, reviews the diff against the current Snipe-IT state, and approves or rejects.
3. On approval, the app syncs changes to Snipe-IT and records a snapshot of the resulting state.
4. Approved sessions can be reverted, which undoes the Snipe-IT changes recorded at approval time.

## Snipe-IT Sync

The `lib/snipeit-sync.js` module handles all write operations to Snipe-IT:

- Assigns and unassigns assets to users and locations.
- Checks components in/out.
- Records the pre-approval device state so reverts are possible.

Set `SNIPEIT_DRY_RUN=true` to validate the sync logic without writing anything.

## Python Import Scripts

Bulk import tools are in `scripts/`:

| Script | Purpose |
| --- | --- |
| `import_to_snipeit.py` | General-purpose asset/component importer. |
| `import_component_batch.py` | Batch-imports components from a TSV file, with dry-run support. |

Example dry run:

```bash
python3 scripts/import_component_batch.py data/component_batch_2026-04-09.tsv --dry-run
```

## Project Layout

```text
inventory-mail-generator/
├── data/           # Seed inventory JSON and TSV files
├── lib/            # Shared server modules (Snipe-IT client, sync, sessions, notifications)
├── middleware/     # Auth middleware, PIN checks, role enforcement
├── public/         # Login page, app UI, CSS, and browser scripts
├── routes/         # Auth, sessions, inventory search, OCR, Snipe-IT, approval, notifications
├── scripts/        # Python import scripts and auth bootstrap
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

# Bootstrap admin auth on a fresh instance
npm run bootstrap-auth

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
- Snipe-IT writes are idempotent where possible; the sync layer compares current state before making changes.
