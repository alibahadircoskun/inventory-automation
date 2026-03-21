# Inventory Mail Generator

Internal web app for building inventory handoff emails from device lists, component lookups, and OCR-assisted label capture.

The app runs as a small Express server with a SQLite database, serves a login screen plus editor UI, and can call an OpenAI-compatible vision endpoint to read hardware labels from camera or gallery images.

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

## Environment Variables

Create `.env` from `.env.example` and fill in real values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | No | HTTPS port. Defaults to `3000`. |
| `AI_API_URL` | Yes for OCR | OpenAI-compatible vision/chat completions endpoint. |
| `AI_API_KEY` | Yes for OCR | Primary API key. |
| `AI_API_KEYS` | No | Comma-separated fallback keys. The app rotates keys on `429` responses. |
| `AI_MODEL` | Yes for OCR | Model name sent to the provider. |

If no OCR keys are configured, the app still starts, but OCR requests will fail until the variables are set.

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
```

## Notes

- The repo includes the bundled inventory seed files but does not include the live SQLite database.
- The repo does not include generated TLS certs.
- OCR expects an OpenAI-compatible API shape, even if the provider is not OpenAI itself.
