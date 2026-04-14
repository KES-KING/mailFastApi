# mailFastApi

High-performance Node.js email microservice with split core/web architecture.

Core design:

- Incoming email requests are written to Redis queue immediately.
- Worker processes consume Redis jobs and deliver via pooled SMTP.
- System logs are persisted to SQLite and file logs simultaneously.
- Monitor web panel is served by a separate web service.

## Architecture

```text
Client -> Core API (/send, /auth/token, /health) -> Queue -> Worker -> SMTP Provider
                                     \-> Structured Logger -> SQLite + File + Console
Web Panel Service -> Core Monitor APIs (/monitor/stats, /monitor/stream, /metrics)
                 -> Update Control (updater.sh)
```

## Key Features

- Fast ACK pattern (`202 queued`) without waiting SMTP round-trip
- Redis-backed mail queue (`QUEUE_BACKEND=redis`)
- Global singleton Nodemailer pooled transporter
- Optional per-mail `from`, multi-recipient `to`, and base64 attachments
- Worker retry logic and latency metrics (`queueLatencyMs`, `dispatchLatencyMs`)
- JWT auth (`/auth/token` + Bearer on `/send`) and rate limiting
- Dual log persistence:
  - SQLite (`LOG_DB_PATH`)
  - JSON line file (`LOG_DIR`/`LOG_FILE_NAME`)
- CLI log dashboard:
  - `npm run log mailsender`
  - `npm run log:mailsender`

## Project Structure

```text
mailFastApi/
|-- src/
|   |-- app.js
|   |-- web.js
|   |-- auth.js
|   |-- mailQueueFactory.js
|   |-- memoryMailQueue.js
|   |-- redisMailQueue.js
|   |-- mailer.js
|   |-- queue.js
|   |-- worker.js
|   |-- systemLogger.js
|   `-- systemStore.js
|-- scripts/
|   `-- log-cli.js
|-- docs/
|   `-- API_DOCS.md
|-- Tests/
|-- updater.sh
|-- .env.example
`-- package.json
```

## Environment

See `.env.example` for full reference.

Important variables:

- Queue:
  - `QUEUE_BACKEND=redis`
  - `REDIS_URL=redis://127.0.0.1:6379`
  - `REDIS_QUEUE_KEY=mailfastapi:mail_jobs`
- Logs:
  - `LOG_DB_PATH=data/mailfastapi.sqlite`
  - `LOG_DIR=logs`
  - `LOG_FILE_NAME=system.log`
- SMTP:
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`
- Send payload controls:
  - `REQUEST_BODY_LIMIT` (default `10mb`)
  - `MAX_ATTACHMENTS` (default `10`)
  - `MAX_ATTACHMENT_TOTAL_BYTES` (default `8388608`)
- Live monitor:
  - Core service: `MONITOR_ENABLED`, `MONITOR_UI_ENABLED`, `MONITOR_PATH`, `METRICS_PATH`
  - `MONITOR_SSE_INTERVAL_MS`, `MONITOR_TOKEN`
  - `MONITOR_MAX_RECENT_ENTRIES`, `MONITOR_MAX_TIMELINE_MINUTES`
- Web service:
  - `WEB_PORT`, `WEB_HOST`, `WEB_CORE_BASE_URL`
  - `WEB_ENABLE_UPDATER`, `WEB_UPDATE_SCRIPT`, `WEB_UPDATE_TIMEOUT_MS`
  - `WEB_UPDATE_TOKEN` (optional extra protection for update endpoints)

## Run

```bash
npm install
npm run start:core
npm run start:web
```

Core URL (default): `http://localhost:3000`

Web monitor URL (default): `http://localhost:3300/monitor`

Prometheus metrics URL (default): `http://localhost:3300/metrics`

Formatted monitor pages:

- Metrics view: `http://localhost:3000/monitor/metrics-view`
- Raw snapshot view: `http://localhost:3000/monitor/raw-view`

## Linux Auto Install (dual systemd services)

Project root includes `install.sh` to install dependencies, set up Redis, install npm packages, and register two background services:

- `mailfastapi-core.service`
- `mailfastapi-web.service`

Installer also:

- creates/updates `.env` from `.env.example`
- appends missing core/web settings
- checks core/web ports
- creates runtime directories and permissions
- enables and starts both services

Run installer:

```bash
chmod +x install.sh
./install.sh
```

Common options:

```bash
./install.sh --service-user mailer
./install.sh --app-dir /opt/mailFastApi
./install.sh --skip-system-deps
./install.sh --skip-service
```

Installer output includes a colored ASCII banner and project GitHub link.

## Updater

`updater.sh` checks repository updates and applies them safely with fast-forward only:

```bash
./updater.sh
./updater.sh --check
./updater.sh --apply --yes
```

When an update is applied, dependencies are synced and both services are restarted.
The web monitor includes a `Guncellemeleri Denetle` button that calls updater endpoints.

## Tests

```bash
npm test
```

Real SMTP test:

```bash
npm test mailsend
```

## Log Dashboard

After traffic exists, render CLI dashboard:

```bash
npm run log mailsender
```

Dashboard includes:

- 24h totals (`mail sent`, `mail failed`, retries)
- event/level distributions
- SMTP latency stats
- per-minute throughput graph
- recent structured logs

## API

Endpoint details are in:

- [docs/API_DOCS.md](./docs/API_DOCS.md)
