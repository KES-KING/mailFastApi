# mailFastApi

High-performance Node.js email microservice for asynchronous SMTP delivery.
The API acknowledges requests immediately and pushes delivery to a background worker, so request latency stays low even when SMTP is slow.

## 1. Design Goals

- Keep API response latency low (`POST /send` returns fast with `202 queued`)
- Avoid reconnecting SMTP per request (global pooled transporter)
- Protect send endpoint with modern auth (JWT default, API key optional)
- Provide predictable behavior under load (queue + bounded worker concurrency)
- Support operational visibility (structured timestamped logs + health endpoint)

## 2. Architecture

```text
Client/App
   |
   |  POST /send (JWT or API key)
   v
Express API Layer
   | validate + auth + rate limit
   v
InMemoryQueue (FIFO, bounded)
   |
   | dequeue (background)
   v
Worker Pool (concurrency = WORKER_CONCURRENCY)
   |
   | sendMail() with retries
   v
Nodemailer SMTP Pool (global singleton)
   |
   v
SMTP Server / Provider
```

Core modules:

- `src/app.js`: HTTP server, middleware chain, endpoints, shutdown
- `src/auth.js`: auth configuration, client credential validation, JWT issue/verify
- `src/mailer.js`: singleton pooled SMTP transporter
- `src/queue.js`: bounded in-memory FIFO queue implementation
- `src/worker.js`: async dequeue/send/retry execution engine

## 3. Request Lifecycle (`POST /send`)

1. Request enters Express JSON parser (`100kb` limit).
2. Global rate limiter checks per-IP quota.
3. Auth middleware validates token/key based on `AUTH_MODE`.
4. Payload validation checks `to`, `subject`, `html`.
5. Job object is created (`jobId`, payload, `queuedAt`) and enqueued.
6. API returns `202 { "status": "queued" }` immediately.
7. Worker consumes queue in background and calls pooled `sendMail`.
8. On failure worker retries (`RETRY_ATTEMPTS`, `RETRY_DELAY_MS`).
9. Logs emit queue and SMTP latency metrics (`queueLatencyMs`, `dispatchLatencyMs`).

## 4. Delivery Semantics and Guarantees

- API guarantee: successful `202` means job accepted into in-memory queue.
- Delivery guarantee: best-effort with bounded retries (not exactly-once).
- Ordering: FIFO queue order is preserved; worker concurrency can complete jobs out of strict global order when `WORKER_CONCURRENCY > 1`.
- Persistence: queue is memory-backed only. Process crash/restart can lose in-flight queued jobs.
- Idempotency: not built-in yet; clients should implement their own dedupe keys if duplicate send prevention is required.

## 5. Security Model

`AUTH_MODE` options:

- `jwt` (default): `POST /auth/token` issues short-lived bearer tokens
- `api_key`: `POST /send` requires `x-api-key`
- `none`: auth disabled (only recommended for local development)

JWT verification includes:

- Signature algorithm: `HS256`
- Issuer check: `JWT_ISSUER`
- Audience check: `JWT_AUDIENCE`
- Expiration check: `JWT_EXPIRES_IN`
- Scope check: must include `mail:send`

Additional controls:

- Constant-time credential comparison for client secrets
- Token endpoint specific rate limiter (`TOKEN_RATE_LIMIT_*`)
- General API rate limiter (`RATE_LIMIT_*`)

## 6. Configuration Reference

All variables are defined in `.env` / `.env.example`.

| Variable | Default | Required | Purpose | Technical Notes |
|---|---|---|---|---|
| `PORT` | `3000` | No | HTTP listen port | Set via container/env in production |
| `MAIL_FROM` | `SMTP_USER` or fallback | No | Envelope sender | Fallback: `no-reply@mailfastapi.local` |
| `SMTP_HOST` | `localhost` | Yes (prod) | SMTP hostname | Required for real provider |
| `SMTP_PORT` | `587` | Yes (prod) | SMTP port | `465` usually with `SMTP_SECURE=true` |
| `SMTP_SECURE` | `false` | No | TLS mode | Boolean string (`true`/`false`) |
| `SMTP_USER` | empty | Provider-dependent | SMTP auth user | Used when auth required |
| `SMTP_PASS` | empty | Provider-dependent | SMTP auth password/app-password | Keep in secret store |
| `SMTP_MAX_CONNECTIONS` | `5` | No | Pool size | Increase carefully with provider limits |
| `SMTP_MAX_MESSAGES` | `100` | No | Messages per pooled connection | Helps recycle stale connections |
| `SMTP_RATE_LIMIT` | `10` | No | Max messages per window | Works with `SMTP_RATE_DELTA` |
| `SMTP_RATE_DELTA` | `1000` | No | Rate window in ms | Example: `10/1000ms` |
| `QUEUE_MAX_SIZE` | `50000` | No | Max queued jobs | Returns `503` when full |
| `WORKER_CONCURRENCY` | `2` | No | Parallel worker runners | Controls SMTP parallelism at app layer |
| `RETRY_ATTEMPTS` | `3` | No | Max send attempts per job | Includes first attempt |
| `RETRY_DELAY_MS` | `250` | No | Base retry backoff | Attempt-based linear delay |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | No | Graceful drain timeout | Force exit after timeout |
| `RATE_LIMIT_WINDOW_MS` | `60000` | No | Global limiter window | Per IP |
| `RATE_LIMIT_MAX` | `120` | No | Global max requests/window | Per IP |
| `AUTH_MODE` | `jwt` | No | Auth strategy | `jwt`, `api_key`, `none` |
| `API_KEY` | empty | Only in `api_key` mode | Static key for `/send` | Use long random secret |
| `JWT_SECRET` | empty | Yes in `jwt` mode | JWT signing key | Must be long random string |
| `JWT_ISSUER` | `mailFastApi` | No | JWT issuer claim | Must match verify side |
| `JWT_AUDIENCE` | `mailfastapi-clients` | No | JWT audience claim | Must match verify side |
| `JWT_EXPIRES_IN` | `5m` | No | Token TTL | Use short TTL in production |
| `AUTH_CLIENT_ID` | empty | Yes in `jwt` mode* | Default client id | *or use `JWT_CLIENTS_JSON` |
| `AUTH_CLIENT_SECRET` | empty | Yes in `jwt` mode* | Default client secret | *or use `JWT_CLIENTS_JSON` |
| `JWT_CLIENTS_JSON` | empty | Optional | Multi-client config | JSON array of clients/scopes |
| `TOKEN_RATE_LIMIT_WINDOW_MS` | `60000` | No | Token endpoint limiter window | Per IP |
| `TOKEN_RATE_LIMIT_MAX` | `30` | No | Token endpoint max req/window | Per IP |
| `TEST_MAIL_TO` | empty | Only for mailsend test | Real recipient for test mode | Used by `npm test mailsend` |

## 7. Installation and Run

```bash
npm install
npm start
```

Base URL (default): `http://localhost:3000`

## 8. API Summary

- `POST /auth/token` (JWT mode only): issue bearer token
- `POST /send`: validate + enqueue mail job
- `GET /health`: readiness/observability snapshot

Detailed contract:

- [docs/API_DOCS.md](./docs/API_DOCS.md)

## 9. Testing Strategy

Command matrix:

- `npm test`: unit + integration tests in isolated mode
- `npm test mailsend`: includes real SMTP probe + metrics report emails
- `npm run test:mailsend`: alias for mailsend mode

Test docs:

- [Tests/README.md](./Tests/README.md)

## 10. Performance Tuning Guide

When throughput is low:

1. Increase `WORKER_CONCURRENCY` gradually.
2. Tune `SMTP_MAX_CONNECTIONS` in line with provider limits.
3. Align `SMTP_RATE_LIMIT`/`SMTP_RATE_DELTA` with provider throttling policy.

When queue grows continuously:

1. Observe `queueDepth` and `activeJobs` on `/health`.
2. Increase queue size only if memory budget allows.
3. Scale horizontally (multiple instances) and shard traffic upstream.

Latency indicators in logs:

- `queueLatencyMs`: time from enqueue to worker pickup/send start
- `dispatchLatencyMs`: SMTP call duration for successful attempt

## 11. Operational Runbook

Startup:

1. Validate env and secrets.
2. Start process (`npm start`, PM2, systemd, or container entrypoint).
3. Check `/health` and startup logs (`mailFastApi started`).

Shutdown:

1. Send `SIGTERM`.
2. Server stops accepting new requests.
3. Worker drains until timeout.
4. Transporter closes pooled connections.

Recommended production stack:

- Reverse proxy (TLS termination, IP allow/deny, extra rate limits)
- Centralized logs (ELK/Loki/Datadog)
- Runtime supervisor (PM2/systemd/Kubernetes)
- Secret management (Vault, cloud secret manager, CI/CD injection)

## 12. Limitations

- Queue is in-memory only (no durability across crashes/restarts)
- No built-in distributed queue/consumer coordination
- No first-class idempotency key support yet
- No webhook/callback for final delivery status yet

## 13. Suggested Next Steps

1. Add Redis/BullMQ adapter for durable queueing.
2. Add idempotency key and dedupe window.
3. Add structured logger backend and metrics endpoint.
4. Add dead-letter queue for repeatedly failed jobs.
