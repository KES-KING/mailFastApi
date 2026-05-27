# MailFastApi Test Report

Generated: 2026-05-27, Europe/Istanbul

This report records the local verification run used for the public GPL-ready README update.
No real SMTP delivery was triggered during the load smoke test.

## Environment

| Item | Value |
|---|---|
| OS shell | Windows PowerShell |
| Node.js | v22.22.2 |
| npm | 11.12.1 |
| Core dev service | `http://127.0.0.1:3000/health` returned `200` |
| Web dev service | `http://127.0.0.1:8080/health` returned `200` |

## Automated Test Suite

Command:

```bash
npm test
```

Result:

| Metric | Value |
|---|---:|
| Suites | 17 |
| Tests | 73 |
| Passed | 72 |
| Failed | 0 |
| Skipped | 1 |
| Duration | 3660.7328 ms |

The skipped test is the explicit real SMTP send path. It is intentionally skipped unless
`mailsend` mode and recipient SMTP test settings are provided.

## Syntax And Whitespace Checks

Commands:

```bash
node --check src/app.js
node --check src/appSettings.js
node --check src/web.js
node --check src/monitor.js
node --check src/secureStore.js
node --check src/worker.js
node --check scripts/updater.js
node --check Tests/load/autocannon-send.js
node --check Tests/load/overload-send.js
node --check Tests/unit/appSettings.test.js
git diff --check
```

Result: pass.

## Overload Plan Dry Run

Command:

```bash
npm run test:overload
```

Result: pass. The helper calculated the current development overload profile without sending real mail:

| Item | Value |
|---|---:|
| Profile | `api-limit` |
| Total attempts | 150 |
| Concurrency | 20 |
| API rate limit | 120 / 60000 ms |
| Queue backend | `memory` |
| Worker concurrency | 2 |

Real overload execution remains opt-in with `OVERLOAD_CONFIRM_REAL_SEND=true`.

## Web Visual Smoke

Screenshots were captured with Playwright CLI from local development services:

| View | Asset |
|---|---|
| Legacy web login | `docs/assets/web-login.png` |
| Monitor desktop | `docs/assets/web-monitor-desktop.png` |
| Monitor mobile | `docs/assets/web-monitor-mobile.png` |
| Encrypted settings | `docs/assets/web-settings.png` |

Result: pass. The rendered legacy screens are nonblank and usable at desktop and mobile widths.

## Load Smoke Test

Command:

```bash
npm run test:load:autocannon
```

Execution model:

- Temporary isolated API-only instance.
- `MAILFASTAPI_ROLE=api`.
- `QUEUE_BACKEND=memory`.
- Worker disabled, so SMTP delivery was not attempted.
- Isolated SQLite/log paths under the local temp directory.
- `CONNECTIONS=2`, `DURATION=3`, `OVERALL_RATE=5`.

Result:

| Metric | Value |
|---|---:|
| HTTP 202 responses in rendered status table | 16 |
| Non-2xx status bucket | not reported |
| Average latency | 7.15 ms |
| p50 latency | 5 ms |
| p97.5 latency | 21 ms |
| Max latency | 23 ms |
| Average request rate | 5.34 req/s |
| Total requests | 21 |
| Duration | 3.02 s |

Note: this is a smoke benchmark for queue acceptance and API overhead, not a production capacity benchmark.
Production load testing must run against Redis-backed durable queue, separated API/worker nodes, and provider-safe
SMTP sandboxes or provider-approved test accounts.

## Manual/External Tests Not Run In This Local Report

| Test | Reason |
|---|---|
| `npm test mailsend` | Avoided real email delivery; requires `TEST_MAIL_TO` and a configured encrypted SMTP account |
| `k6 run Tests/load/k6-send.js` | Template is present; full k6 run should be executed in a dedicated benchmark environment |
| Network partition and Redis outage chaos tests | Require controlled Redis/RabbitMQ/infrastructure fault injection |
| Signed release verification against real tags | Requires production signing keys and release tags |
| DNS deliverability checks for owned domains | Require real SPF/DKIM/DMARC/MX/MTA-STS/TLS-RPT DNS records |

## Verification Checklist

- [x] Automated unit and integration tests passed.
- [x] Node syntax checks passed.
- [x] Whitespace diff check passed.
- [x] Legacy web screenshots captured.
- [x] API-only load smoke produced successful `202 queued` responses.
- [x] No real SMTP send was triggered by the load smoke.
- [ ] Real SMTP delivery test run in a controlled mailbox.
- [ ] k6 benchmark run against durable queue topology.
- [ ] Chaos/failure tests run against production-like infrastructure.
- [ ] Signed-tag updater flow verified against real release artifacts.
