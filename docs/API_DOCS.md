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
- Background workers consume leased queue jobs and deliver via the selected SMTP account pool.
- Redis processing leases requeue expired jobs after `QUEUE_VISIBILITY_TIMEOUT_MS`.
- Workers acknowledge jobs only after success or final dead-letter state.
- Dead-lettered jobs can be listed and retried through authenticated DLQ recovery endpoints.
- Workers automatically retry pending DLQ jobs when `DLQ_AUTO_RETRY_ENABLED=true`; exhausted rows are marked as final error.
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
  "tenantId": "tenant_a",
  "category": "transactional",
  "returnPath": "bounces+custom@example.com",
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
- `smtpAccount`, `from`, `returnPath`, `text`, and `attachments` are optional.
- `tenantId` is optional and can also be supplied with `x-tenant-id`.
- `category` defaults to `transactional`; accepted values are `transactional`, `security`, `notification`, `marketing`, `bulk`.
- If `smtpAccount` is omitted, the API uses the default account saved in the encrypted SMTP vault.
- If `from` matches a configured account sender address, that account is selected automatically.
- `attachments[].content` must be base64.
- Inline attachments are supported via `attachments[].content_id` (mapped to SMTP `cid`).
- When `IDEMPOTENCY_ENABLED=true`, send retries can include the configured idempotency header
  (`idempotency-key` by default). Matching requests replay the first response. Reusing the same
  key with a different request returns `409`.
- Suppression checks apply to the configured categories (`marketing,bulk` by default). Suppressed
  recipients return `409`.
- Marketing/bulk messages include one-click unsubscribe headers when `PUBLIC_BASE_URL` and
  `UNSUBSCRIBE_SECRET` are configured.
- If `BOUNCE_DOMAIN` is configured, the API generates a dedicated Return-Path when `returnPath` is omitted.

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
- `409` idempotency conflict or suppressed recipient
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
  "processingDepth": 1,
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
- `GET /domain-health/:domain` -> SPF, DKIM selector, DMARC, MX, MTA-STS, and TLS-RPT diagnostics

Domain health example:

```bash
curl -H "x-monitor-token: <TOKEN>" \
  "http://localhost:3000/domain-health/example.com?selector=default,mail"
```

## Unsubscribe Endpoint

When `PUBLIC_BASE_URL` and `UNSUBSCRIBE_SECRET` are set, marketing/bulk mail gets a signed
unsubscribe URL.

- `GET /unsubscribe?email=<EMAIL>&tenantId=<TENANT>&token=<TOKEN>`
- `POST /unsubscribe`

Successful unsubscribe creates a tenant-level suppression entry in the operational store.

## Bounce and Complaint Webhooks

Webhook ingestion is enabled with `BOUNCE_WEBHOOK_ENABLED=true` and protected by
`x-webhook-token: <BOUNCE_WEBHOOK_TOKEN>`.

Hard bounce example:

```bash
curl -X POST http://localhost:3000/webhooks/bounce \
  -H "Content-Type: application/json" \
  -H "x-webhook-token: <TOKEN>" \
  -d "{\"email\":\"user@example.com\",\"tenantId\":\"tenant_a\",\"responseCode\":550,\"response\":\"user unknown\"}"
```

Complaint example:

```bash
curl -X POST http://localhost:3000/webhooks/complaint \
  -H "Content-Type: application/json" \
  -H "x-webhook-token: <TOKEN>" \
  -d "{\"email\":\"user@example.com\",\"tenantId\":\"tenant_a\",\"provider\":\"ses\"}"
```

Hard bounces and complaints automatically create tenant-level suppression entries.

## Legacy Web Panel

The separate web panel service listens on fixed port `8080`.

- First access redirects to `GET /setup` and requires creating the web panel password.
- When `WEB_MFA_REQUIRED=true`, `GET /mfa/setup` and `POST /mfa/setup` enroll local TOTP MFA before the first panel session is created.
- When `WEB_MFA_REQUIRED=false`, dev login uses the web panel password only.
- After setup, unauthenticated users are redirected to `GET /login`; production mode must use password + TOTP/recovery code.
- `GET /` -> live monitor UI at the root URL
- `GET /smtp` -> encrypted SMTP account management
- `POST /smtp/accounts` -> create/update an SMTP account
- `POST /smtp/default` -> set default SMTP account
- `POST /smtp/accounts/delete` -> delete an SMTP account
- `GET /dead-letters` -> list failed/dead-lettered jobs; requires JWT `admin`/`operator` role or API key auth
- `POST /dead-letters/retry` -> requeue pending failed jobs; body supports `ids`, `limit`, `dryRun`, and `force`
- `GET /stats` -> authenticated proxied core monitor snapshot
- `GET /stream` -> authenticated proxied core monitor SSE stream
- `GET /metrics-view` -> authenticated formatted Prometheus metrics page
- `GET /raw-view` -> authenticated formatted snapshot page
- `GET /metrics` -> authenticated proxied Prometheus text metrics
- `POST /sessions/revoke` -> admin-only revoke-all web sessions
- `GET /update` -> authenticated legacy update control page with progress bar
- `GET /update/check` -> authenticated secure updater check
- `POST /update/start` -> authenticated secure updater background start with CSRF
- `GET /update/status` -> authenticated secure updater progress snapshot
- `POST /update/apply` -> authenticated secure updater apply with CSRF

The live UI includes SMTP account filtering. Use `smtpAccount` in `/send` requests to route mail and to make account-specific views reliable.
When `WEB_UPDATE_TOKEN` is set, update endpoints also require the `x-update-token` header.

## Redis Queue Notes

- Backend selection: `QUEUE_BACKEND=redis|memory`
- Recommended: `redis` for production
- Pending queue key: `REDIS_QUEUE_KEY`
- Processing queue key: `${REDIS_QUEUE_KEY}:processing`
- Lease sorted set: `${REDIS_QUEUE_KEY}:processing:leases`
- Connection URL: `REDIS_URL`
- Command timeout: `REDIS_COMMAND_TIMEOUT_MS`
- Visibility timeout: `QUEUE_VISIBILITY_TIMEOUT_MS`
- Reclaim interval: `QUEUE_RECLAIM_INTERVAL_MS`

Production mode rejects `QUEUE_BACKEND=memory`.

## Delivery Policy and DKIM

`DELIVERY_POLICY_ENABLED=true` enables domain/account quota checks from operational delivery events.
Built-in policy buckets are Gmail, Outlook, Yahoo, and Corporate. Override with:

- `DOMAIN_POLICIES_JSON`
- `SMTP_ACCOUNT_POLICIES_JSON`

`DKIM_SIGNING_ENABLED=true` signs outgoing messages with Nodemailer DKIM options. Configure:

- `DKIM_DOMAIN`
- `DKIM_SELECTOR`
- `DKIM_PRIVATE_KEY_PATH` or `DKIM_PRIVATE_KEY`
- `DKIM_KEYS_JSON` for multiple domains

## SMTP Account Routing

SMTP credentials are not read from `.env` in production runtime.

1. Set `SECURE_STORE_KEY` in `.env` to a long random value, or set `SECURE_STORE_KEY_FILE` to a mounted secret file.
2. Start the web panel on `http://localhost:8080`.
3. Create the web panel password on first access.
4. Open `SMTP Accounts` and add accounts such as `2fa`, `info@example.com`, or `Bilgi Maili`.
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

## Secure Updater

The updater is implemented in `scripts/updater.js`. `updater.sh` remains as a wrapper for compatibility.

Update modes:

- `branch`: fetches the configured upstream branch and applies only fast-forward updates.
- `tag`: selects the latest tag matching `UPDATER_ALLOWED_TAG_PATTERN`, or uses `UPDATER_TARGET` when set.

Security controls:

- Working tree must be clean unless `--allow-dirty` is used from CLI.
- Web panel update calls do not pass `--allow-dirty`.
- Update apply uses a lock file at `data/updater.lock`.
- `UPDATER_REQUIRE_SIGNED_TAG=true` requires signed annotated tags in tag mode.
- Post-merge failures trigger rollback to the previous commit when the original worktree was clean.
- Dependency sync uses `npm ci --omit=dev` when `package-lock.json` exists.
- If service `PATH` does not include `npm`, the updater tries the `npm-cli.js` bundled next to the active Node.js runtime; `UPDATER_NPM_BIN` can override this.
- Syntax checks always run; `UPDATER_RUN_TESTS=true` also runs `npm test`.
- Core and web health checks run after synchronous restarts.

Commands:

```bash
npm run update:check
npm run update:apply
node scripts/updater.js --check --release-mode tag
node scripts/updater.js --apply --yes --release-mode tag --target v1.2.3
```

## Cross-Platform Deployment

For deployment, use the cross-platform installer entrypoint:

```bash
chmod +x installer.sh
./installer.sh
```

Native Windows:

```powershell
.\install.ps1
# or
.\installer.cmd
```

Installer behavior for environment config:

- reads `.env.example`
- creates/updates `.env`
- generates `SECURE_STORE_KEY` and `MONITOR_TOKEN` if missing/default
- appends missing service defaults without overwriting existing custom values

Installer capabilities:

- dispatches to Linux systemd, macOS launchd, or Windows Scheduled Tasks
- installs platform dependencies where supported
- installs Node.js 22 LTS if needed
- enables Redis where supported; Windows falls back to `QUEUE_BACKEND=memory` on first-run when Redis is not detected
- installs npm dependencies in project directory
- creates and starts platform services/tasks unless skipped

Post-install useful commands:

```bash
# Linux
sudo systemctl status mailfastapi-core mailfastapi-web
sudo journalctl -u mailfastapi-core -u mailfastapi-web -f

# macOS
launchctl list | grep mailfastapi

# Windows PowerShell
Get-ScheduledTask -TaskName 'mailfastapi-*'
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
