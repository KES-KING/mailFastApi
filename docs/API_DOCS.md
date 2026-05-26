# mailFastApi API Documentation

## Transport

- Protocol: HTTP/1.1
- Content-Type: `application/json`
- Runtime: Node.js `>=22.5.0`
- Base URL: `http://localhost:3000` (default)
- Monitor base URL: same as `Base URL` by default. If `MONITOR_PORT` is set to a different value than `PORT`, monitor endpoints are exposed on `http://localhost:<MONITOR_PORT>`.
- Legacy web panel URL: `http://localhost:8080` (root path, no `/monitor` suffix).

## Queue & Processing Model

- `/send` does **not** send mail synchronously.
- Request payload is pushed to Redis queue (`REDIS_QUEUE_KEY`).
- Background workers consume queue and deliver via the selected SMTP account pool.
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

\* Core monitor/metrics endpoints require `x-monitor-token` when `MONITOR_TOKEN` is set. The separate legacy web panel uses its own password session and proxies the core token server-side.

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
  "smtpAccount": "info",
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
- `smtpAccount`, `from`, `text`, and `attachments` are optional.
- If `smtpAccount` is omitted, the API uses the default account saved in the encrypted SMTP vault.
- If `from` matches a configured account sender address, that account is selected automatically.
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
- If `MONITOR_PORT` is configured and differs from API `PORT`, open this endpoint from monitor port.

Related endpoints:

- `GET /monitor/stats` -> JSON snapshot
- `GET /monitor/stream` -> Server-Sent Events live snapshot stream
- `GET /monitor/metrics-view` -> formatted Prometheus metrics page
- `GET /monitor/raw-view` -> formatted raw snapshot JSON page
- `GET /metrics` -> Prometheus text metrics

## Legacy Web Panel

The separate web panel service listens on fixed port `8080`.

- First access redirects to `GET /setup` and requires creating the web panel password.
- After setup, unauthenticated users are redirected to `GET /login`.
- `GET /` -> live monitor UI at the root URL
- `GET /smtp` -> encrypted SMTP account management
- `POST /smtp/accounts` -> create/update an SMTP account
- `POST /smtp/default` -> set default SMTP account
- `POST /smtp/accounts/delete` -> delete an SMTP account
- `GET /stats` -> authenticated proxied core monitor snapshot
- `GET /stream` -> authenticated proxied core monitor SSE stream
- `GET /metrics-view` -> authenticated formatted Prometheus metrics page
- `GET /raw-view` -> authenticated formatted snapshot page
- `GET /metrics` -> authenticated proxied Prometheus text metrics

The live UI includes SMTP account filtering. Use `smtpAccount` in `/send` requests to route mail and to make account-specific views reliable.

## Redis Queue Notes

- Backend selection: `QUEUE_BACKEND=redis|memory`
- Recommended: `redis` for production
- Queue key: `REDIS_QUEUE_KEY`
- Connection URL: `REDIS_URL`
- Command timeout: `REDIS_COMMAND_TIMEOUT_MS`

## SMTP Account Routing

SMTP credentials are not read from `.env` in production runtime.

1. Set `SECURE_STORE_KEY` in `.env` to a long random value.
2. Start the web panel on `http://localhost:8080`.
3. Create the web panel password on first access.
4. Open `SMTP Accounts` and add accounts such as `2fa`, `info`, or `marketing`.
5. Set one saved account as the default.

The encrypted vault is `data/mailfastapi-secure.sqlite` by default. SMTP account records are encrypted with AES-256-GCM using a key derived from `SECURE_STORE_KEY`.

Then send with:

```json
{
  "smtpAccount": "2fa",
  "to": "user@example.com",
  "subject": "2FA Code",
  "html": "<p>Your code is 123456.</p>"
}
```

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
- generates `SECURE_STORE_KEY` and `MONITOR_TOKEN` if missing/default
- appends missing service defaults without overwriting existing custom values

Installer capabilities:

- installs OS dependencies (curl, build toolchain, sqlite, redis)
- installs Node.js 22 LTS if needed
- ensures Redis service is enabled and running
- installs npm dependencies in project directory
- creates and enables systemd units (`mailfastapi-core.service`, `mailfastapi-web.service`)

Post-install useful commands:

```bash
sudo systemctl status mailfastapi-core mailfastapi-web
sudo journalctl -u mailfastapi-core -u mailfastapi-web -f
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
