# mailFastApi

High-performance Node.js email microservice.

Core design:

- Incoming email requests are written to Redis queue immediately.
- Worker processes consume Redis jobs and deliver via pooled SMTP.
- System logs are persisted to SQLite and file logs simultaneously.

## Architecture

```text
Client -> POST /send -> Auth + Validate -> Redis Queue -> Worker -> SMTP Pool -> Provider
                                      \-> Structured Logger -> SQLite + File + Console
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
  - `MONITOR_ENABLED`, `MONITOR_PATH`, `METRICS_PATH`
  - `MONITOR_SSE_INTERVAL_MS`, `MONITOR_TOKEN`
  - `MONITOR_MAX_RECENT_ENTRIES`, `MONITOR_MAX_TIMELINE_MINUTES`

## Run

```bash
npm install
npm start
```

Default URL: `http://localhost:3000`

Live monitor URL (default): `http://localhost:3000/monitor`

Prometheus metrics URL (default): `http://localhost:3000/metrics`

## Linux Auto Install (systemd service)

Project root includes `install.sh` to install dependencies, set up Redis, install npm packages, and register `mailFastApi` as a background Linux service.
During setup, installer converts `.env.example` into `.env` and asks each variable interactively.
Press `Enter` to keep the shown default value.

Run:

```bash
chmod +x install.sh
./install.sh
```

Common options:

```bash
./install.sh --service-name mailfastapi
./install.sh --service-user mailer
./install.sh --app-dir /opt/mailFastApi
./install.sh --skip-system-deps
./install.sh --skip-service
```

Installer output includes a colored ASCII banner and detailed step-by-step install logs.

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
