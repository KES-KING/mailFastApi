# mailFastApi API Documentation

## Transport

- Protocol: HTTP/1.1
- Content-Type: `application/json`
- Base URL: `http://localhost:3000` (default)

## Queue & Processing Model

- `/send` does **not** send mail synchronously.
- Request payload is pushed to Redis queue (`REDIS_QUEUE_KEY`).
- Background workers consume queue and deliver via SMTP pool.
- API returns `202` immediately after queue write succeeds.

## Authentication Modes

`AUTH_MODE`:

- `jwt` (default)
- `api_key`
- `none` (dev only)

| Endpoint | jwt | api_key | none |
|---|---|---|---|
| `POST /auth/token` | enabled | not registered | not registered |
| `POST /send` | bearer required | `x-api-key` required | open |
| `GET /health` | public | public | public |
| `GET /monitor*` | public* | public* | public* |
| `GET /metrics` | public* | public* | public* |

\* If `MONITOR_TOKEN` is set, monitor/metrics endpoints require `x-monitor-token` header (or `?token=` query).

## Endpoints

## POST `/auth/token` (JWT mode only)

Request:

```json
{
  "clientId": "webapp-default",
  "clientSecret": "change_me_client_secret"
}
```

Success `200`:

```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 300
}
```

Errors:

- `400` invalid body
- `401` invalid credentials
- `429` token rate limit

## POST `/send`

Request:

```json
{
  "to": "user@example.com",
  "subject": "Test Mail",
  "html": "<h1>Hello</h1>",
  "from": "Bookings <reservations@example.com>",
  "text": "Hello",
  "attachments": [
    {
      "filename": "invoice.pdf",
      "content": "<BASE64>",
      "content_type": "application/pdf"
    }
  ]
}
```

Notes:

- `to` can be either a string (`"a@x.com"` or `"a@x.com,b@y.com"`) or an array (`["a@x.com","b@y.com"]`).
- `from`, `text`, and `attachments` are optional.
- `attachments[].content` must be base64.
- Inline attachments are supported via `attachments[].content_id` (mapped to SMTP `cid`).

Success `202`:

```json
{
  "status": "queued"
}
```

Errors:

- `400` invalid payload/json
- `401` auth missing/invalid
- `403` insufficient JWT scope (`mail:send`)
- `429` global rate limit
- `503` queue full (memory backend mode)
- `500` internal/queue/redis error

## GET `/health`

Success `200`:

```json
{
  "status": "ok",
  "uptimeSec": 120.12,
  "queueDepth": 42,
  "activeJobs": 2,
  "authMode": "jwt",
  "queueBackend": "redis"
}
```

## GET `/monitor`

- Built-in web dashboard (Prometheus-like live view) for:
  - `/send` request traffic
  - queue depth / active jobs
  - mail queued/sent/failed counters
  - recent events table (live)

Related endpoints:

- `GET /monitor/stats` -> JSON snapshot
- `GET /monitor/stream` -> Server-Sent Events live snapshot stream
- `GET /metrics` -> Prometheus text metrics

## Redis Queue Notes

- Backend selection: `QUEUE_BACKEND=redis|memory`
- Recommended: `redis` for production
- Queue key: `REDIS_QUEUE_KEY`
- Connection URL: `REDIS_URL`
- Command timeout: `REDIS_COMMAND_TIMEOUT_MS`

## Logging Notes

All runtime logs are persisted to:

- SQLite table: `system_logs` (`LOG_DB_PATH`)
- File: JSONL logs (`LOG_DIR/LOG_FILE_NAME`)
- Console

CLI dashboard:

```bash
npm run log mailsender
```

## Linux Service Deployment

For production-like deployment on Linux, use root-level installer:

```bash
chmod +x install.sh
./install.sh
```

Installer behavior for environment config:

- reads `.env.example`
- creates/updates `.env`
- prompts each key interactively
- `Enter` accepts default value shown in prompt

Installer capabilities:

- installs OS dependencies (curl, build toolchain, sqlite, redis)
- installs Node.js LTS (>=20) if needed
- ensures Redis service is enabled and running
- installs npm dependencies in project directory
- creates and enables systemd unit (`mailfastapi.service` by default)

Post-install useful commands:

```bash
sudo systemctl status mailfastapi
sudo journalctl -u mailfastapi -f
```

## cURL Examples

Token:

```bash
curl -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/json" \
  -d "{\"clientId\":\"webapp-default\",\"clientSecret\":\"change_me_client_secret\"}"
```

Send:

```bash
curl -X POST http://localhost:3000/send \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"to\":\"user@example.com\",\"subject\":\"Test Mail\",\"html\":\"<h1>Hello</h1>\"}"
```
