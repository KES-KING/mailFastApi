# mailFastApi API Documentation

This document defines the HTTP contract, auth rules, response semantics, and operational behavior of `mailFastApi`.

## 1. Transport and Conventions

- Protocol: HTTP/1.1
- Content type: `application/json`
- Character set: UTF-8
- Base URL (default): `http://localhost:3000`
- Time source in logs: ISO-8601 UTC (`new Date().toISOString()`)

General response shape:

- Success: endpoint-specific JSON object
- Error: `{ "error": "<message>" }`

## 2. Auth Modes

`AUTH_MODE` controls authentication behavior:

- `jwt` (default)
- `api_key`
- `none`

Behavior by endpoint:

| Endpoint | `jwt` | `api_key` | `none` |
|---|---|---|---|
| `POST /auth/token` | Enabled | Not registered | Not registered |
| `POST /send` | Bearer token required | `x-api-key` required | No auth required |
| `GET /health` | Public | Public | Public |

## 3. JWT Details (`AUTH_MODE=jwt`)

Issued token format:

- Type: JWT
- Signing algorithm: `HS256`
- Claims:
  - `sub`: client id
  - `scope`: space-separated scopes
  - `iss`: issuer (`JWT_ISSUER`)
  - `aud`: audience (`JWT_AUDIENCE`)
  - `iat` / `exp`
  - `jti`: random UUID

Verification requirements for `/send`:

- Valid signature
- Not expired
- `iss` and `aud` match config
- Scope includes `mail:send`

## 4. Endpoint Specifications

## 4.1 `POST /auth/token` (JWT mode only)

Issues a short-lived access token from client credentials.

Request headers:

- `Content-Type: application/json`

Request body:

```json
{
  "clientId": "webapp-default",
  "clientSecret": "change_me_client_secret"
}
```

Successful response (`200`):

```json
{
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 300
}
```

Error responses:

- `400`: missing/invalid body fields
- `401`: invalid client credentials
- `429`: token endpoint rate limit exceeded

Security notes:

- Keep client secret on backend only.
- Use per-integration client credentials.
- Keep token TTL short (`JWT_EXPIRES_IN`).

## 4.2 `POST /send`

Validates payload and enqueues mail job immediately.

Auth:

- `jwt` mode: `Authorization: Bearer <token>`
- `api_key` mode: `x-api-key: <key>`
- `none` mode: no auth header required

Request headers:

- `Content-Type: application/json`
- Auth header (as above)

Request body:

```json
{
  "to": "user@example.com",
  "subject": "Test Mail",
  "html": "<h1>Hello</h1>"
}
```

Validation rules:

- `to`: required, non-empty, email-like format
- `subject`: required, non-empty string
- `html`: required, non-empty string
- JSON parser limit: 100KB payload

Success response (`202`):

```json
{
  "status": "queued"
}
```

Error responses:

- `400`: invalid JSON or payload validation failure
- `401`: missing/invalid auth token or key
- `403`: JWT valid but missing `mail:send` scope
- `429`: global rate limit exceeded
- `503`: queue full (`QUEUE_MAX_SIZE` reached)
- `500`: internal server error

Asynchronous semantics:

- `202` means "accepted to queue", not "already delivered via SMTP".
- Final SMTP result is emitted in logs (`mail sent` / `mail failed`).

## 4.3 `GET /health`

Provides runtime snapshot.

Response (`200`):

```json
{
  "status": "ok",
  "uptimeSec": 124.2,
  "queueDepth": 3,
  "activeJobs": 2,
  "authMode": "jwt"
}
```

Field meanings:

- `status`: static OK marker
- `uptimeSec`: Node process uptime in seconds
- `queueDepth`: queued jobs waiting in memory queue
- `activeJobs`: current worker in-flight sends
- `authMode`: current auth strategy

## 5. Rate Limiting Behavior

Two in-memory IP-based limiters exist:

1. Global limiter: applied to all routes (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`)
2. Token limiter: additional limiter on `POST /auth/token` (`TOKEN_RATE_LIMIT_*`)

Response when exceeded:

- Status: `429`
- Body: `{ "error": "Too many requests." }`

## 6. Queue and Worker Runtime Semantics

Queue:

- In-memory FIFO with bounded capacity
- O(1) style enqueue/dequeue with head-index compaction
- `503` returned when full

Worker:

- Runs continuously in background
- Parallelism controlled by `WORKER_CONCURRENCY`
- Retries up to `RETRY_ATTEMPTS`
- Linear backoff based on `RETRY_DELAY_MS`

SMTP send logging (`mail sent`) includes:

- `jobId`
- `to`
- `attempt`
- `messageId`
- `queueLatencyMs`
- `dispatchLatencyMs`

## 7. HTTP Status Matrix

| Endpoint | 200 | 202 | 400 | 401 | 403 | 404 | 429 | 500 | 503 |
|---|---|---|---|---|---|---|---|---|---|
| `POST /auth/token` | Yes | No | Yes | Yes | No | Yes* | Yes | Yes | No |
| `POST /send` | No | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes |
| `GET /health` | Yes | No | No | No | No | No | Yes | Yes | No |

`*` `404` occurs when `AUTH_MODE` is not `jwt` because route is not registered.

## 8. Integration Patterns

Recommended architecture:

1. Frontend -> your backend
2. Your backend -> `mailFastApi`

Reason:

- Prevent client secret exposure
- Centralize token caching/retry logic
- Allow policy checks before mail enqueue

## 9. cURL Reference

Get JWT:

```bash
curl -s -X POST http://localhost:3000/auth/token \
  -H "Content-Type: application/json" \
  -d "{\"clientId\":\"webapp-default\",\"clientSecret\":\"change_me_client_secret\"}"
```

Send mail with JWT:

```bash
curl -s -X POST http://localhost:3000/send \
  -H "Authorization: Bearer <JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"to\":\"user@example.com\",\"subject\":\"Test Mail\",\"html\":\"<h1>Hello</h1>\"}"
```

Health:

```bash
curl -s http://localhost:3000/health
```

## 10. Node Backend Integration Example (Token Cache)

```js
const axios = require("axios");

let cachedToken = null;
let tokenExpEpochSec = 0;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpEpochSec - 15) {
    return cachedToken;
  }

  const { data } = await axios.post("http://localhost:3000/auth/token", {
    clientId: process.env.MAILFAST_CLIENT_ID,
    clientSecret: process.env.MAILFAST_CLIENT_SECRET,
  });

  cachedToken = data.access_token;
  tokenExpEpochSec = now + (data.expires_in || 300);
  return cachedToken;
}

async function sendMailViaMailFastApi(payload) {
  const token = await getAccessToken();
  const { data, status } = await axios.post("http://localhost:3000/send", payload, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 2000,
  });

  return { status, data };
}
```

## 11. Observability and Troubleshooting

Important logs:

- `request received`
- `mail queued`
- `mail sent`
- `mail send failed, retrying`
- `mail failed`

Troubleshooting checklist:

1. `401` on `/send`:
   - token missing/expired/wrong issuer/audience/scope
2. `503` on `/send`:
   - queue saturation, inspect `/health.queueDepth`
3. frequent `mail failed`:
   - SMTP host/port/auth/TLS mismatch
   - provider throttling or firewall issue
4. high `queueLatencyMs`:
   - low worker concurrency or SMTP bottleneck

## 12. Security Hardening Checklist

- Enforce HTTPS end-to-end
- Store secrets in secure manager, not source control
- Rotate `JWT_SECRET` and client secrets periodically
- Use strict network policy (only app/backend networks can call API)
- Add reverse proxy WAF and additional L7 rate limits
- Monitor auth failure logs and alert on spikes
