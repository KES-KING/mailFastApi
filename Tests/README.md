# Tests

This folder contains the full automated test harness for `mailFastApi`.

## 1. Objectives

- Validate core correctness of queue/auth modules
- Verify HTTP contract behavior end-to-end
- Verify real SMTP path when explicitly requested (`mailsend` mode)
- Produce actionable diagnostics for delivery/performance behavior

## 2. Test Topology

```text
Tests/
|-- run-tests.js
|-- helpers/
|   `-- server.js
|-- integration/
|   `-- api.integration.test.js
`-- unit/
    |-- auth.test.js
    `-- queue.test.js
```

Responsibilities:

- `run-tests.js`: translates CLI mode into env flags (ex: `MAILSEND_MODE=true`)
- `helpers/server.js`: starts/stops isolated app process for integration tests
- `integration/api.integration.test.js`: API-level behavior, auth flow, mailsend checks
- `unit/*.test.js`: fast deterministic module tests

## 3. Execution Modes

## Standard mode

```bash
npm test
```

Behavior:

- Uses isolated SMTP settings pointing to a non-real SMTP endpoint.
- Ensures contract behavior without external dependency.
- Real-send scenario is skipped.

## Real SMTP mode

```bash
npm test mailsend
```

Alias:

```bash
npm run test:mailsend
```

Behavior:

- Reads your `.env` SMTP values.
- Requires `TEST_MAIL_TO`.
- Sends real emails and validates send completion via runtime logs.

## 4. Required Environment for `mailsend`

Minimum required in `.env`:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_SECURE`
- `TEST_MAIL_TO`

Also ensure auth defaults exist:

- `AUTH_MODE=jwt`
- `AUTH_CLIENT_ID`
- `AUTH_CLIENT_SECRET`

## 5. Real MailSend Flow (Detailed)

When `npm test mailsend` runs:

1. Test server starts with real SMTP env.
2. Test gets JWT via `/auth/token`.
3. Probe email is sent to `TEST_MAIL_TO`.
4. Test parses server logs and waits for matching `mail sent` event.
5. Collected runtime and performance metrics are assembled.
6. Metrics report email is sent to `TEST_MAIL_TO`.
7. Test waits for second `mail sent` confirmation.

This means `mailsend` emits 2 emails:

- Probe email
- Metrics report email

## 6. Metrics Included in Report Email

Mail system metrics:

- `jobId`
- `messageId`
- send `attempt`
- `queueLatencyMs`
- `dispatchLatencyMs`

Performance metrics:

- token endpoint latency
- send endpoint ACK latency (`202` round trip)
- end-to-end delivery latency (request start -> `mail sent` log timestamp)
- health snapshot before and after probe send

## 7. Debugging Failed `mailsend`

Typical failures and checks:

1. SMTP auth failure:
   - verify `SMTP_USER`/`SMTP_PASS`
   - for Gmail/Outlook use app password if required
2. TLS mismatch:
   - `SMTP_SECURE=true` usually with port `465`
   - `SMTP_SECURE=false` usually with port `587`
3. Network/firewall:
   - test outbound access to provider host/port
4. recipient rejection:
   - verify `TEST_MAIL_TO` mailbox and provider policy
5. timeout waiting for send log:
   - inspect server logs in test output for retry/failure details

## 8. CI Recommendations

- Run `npm test` on every PR/push.
- Keep `mailsend` as optional/manual pipeline stage (requires secrets).
- Never expose real SMTP secrets in public CI logs.
- Rotate CI-managed SMTP credentials periodically.

## 9. Extending the Suite

Recommended additions:

1. Add auth-mode matrix tests (`jwt`, `api_key`, `none`)
2. Add stress tests for queue saturation (`503` threshold assertions)
3. Add rate-limit behavior tests (`429` windows)
4. Add snapshot tests for error body consistency
