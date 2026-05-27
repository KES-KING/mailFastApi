# MailFastApi Enterprise Hardening Blueprint

This document is the production architecture and verification map for the current hardening pass.
It separates controls implemented in this repository from controls that require production
infrastructure, DNS ownership, identity provider policy, or external provider integrations.

## Current Production Architecture

```text
Tenant client
  -> Core API instances (MAILFASTAPI_ROLE=api)
       - auth, rate limit, payload validation
       - idempotency record write
       - suppression check
       - durable queue write
  -> Redis durable queue
       - pending list
       - processing list
       - processing lease sorted set
       - visibility timeout reclaimer
  -> Worker instances (MAILFASTAPI_ROLE=worker)
       - SMTP account pool per worker process
       - retry with exponential backoff and jitter
       - List-Unsubscribe headers for marketing/bulk mail
       - DLQ write after final failure
       - queue ack after terminal state
  -> SMTP providers

Operational SQLite store
  - idempotency records
  - global and tenant suppression entries
  - dead-letter jobs
  - hash-chained audit events

Encrypted SQLite vault
  - SMTP credentials
  - web admin password verifier
```

## Implemented Controls

| Area | Control | Implementation |
|---|---|---|
| API/worker split | API and worker roles can run separately | `MAILFASTAPI_ROLE=api|worker|all` |
| Production guard | Blocks unsafe production mode | `src/productionGuard.js` |
| Durable queue | Redis required in production | `PRODUCTION_MODE=true` rejects `QUEUE_BACKEND=memory` |
| Visibility timeout | Expired processing jobs are requeued | Redis processing list + lease sorted set |
| At-least-once delivery | Jobs are acked only after terminal worker state | `queue.ack()` from worker |
| Idempotency | Client retries do not duplicate queue writes | Operational SQLite idempotency records |
| Lifecycle | Job state machine records queue and terminal states | `job_lifecycle_events` |
| Domain policy | Gmail/Outlook/Yahoo/corporate quota buckets | `src/deliveryPolicy.js` |
| Bounce classifier | Hard/soft/greylist/complaint classification | `src/bounceClassifier.js` |
| DLQ | Final worker failures are persisted | `dead_letter_jobs` |
| Suppression | Global and tenant recipient suppression | `suppression_entries` |
| Complaint ingestion | Feedback-loop webhook suppresses recipients | `POST /webhooks/complaint` |
| One-click unsubscribe | RFC style unsubscribe headers | `List-Unsubscribe`, `List-Unsubscribe-Post` |
| Audit | Hash-chained append-only event records | `audit_events` |
| RBAC | Web role middleware for admin/operator/viewer/smtp-manager | `src/webAuth.js` |
| TOTP MFA | First-run local MFA enrollment and login verification when `WEB_MFA_REQUIRED=true` | `src/totp.js`, `src/secureStore.js`, `src/web.js` |
| CSP | Web panel uses per-response nonce CSP | `src/webAuth.js` |
| DKIM signing | Nodemailer DKIM options from env/file config | `src/dkimConfig.js` |
| Domain health | SPF, DKIM, DMARC, MX, MTA-STS, TLS-RPT DNS checks | `/domain-health/:domain` |
| Observability | Queue, processing, delivery events, active jobs | `/health`, `/metrics`, monitor snapshot |

## Critical External Controls

These are mandatory for a real enterprise deployment but cannot be completed by repository code alone:

| Control | Required production dependency |
|---|---|
| WebAuthn/federated MFA | External identity provider or WebAuthn/FIDO2 enrollment if phishing-resistant MFA is required |
| Admin public access ban | VPN, private subnet, reverse proxy IP allowlist, or zero-trust gateway |
| KMS/Vault secret source | Cloud KMS, HashiCorp Vault, or OS secret store integration beyond file-based secret source |
| DKIM DNS publication | DNS ownership and key rotation operations |
| DMARC enforcement | Domain DNS policy change to `p=quarantine` then `p=reject` |
| Complaint/FBL subscription | Provider feedback-loop enrollment and provider-specific payload mapping |
| Blacklist monitoring | External DNSBL/seed-list provider integration |
| Full distributed tracing | OpenTelemetry collector and backend |
| Release signing | Signed git tags/releases and trusted public keys on hosts |

Production must not be declared ready until the external controls above are configured and tested.

## Threat Model

### Assets

- SMTP credentials and sender identities.
- Tenant mail content, recipient addresses, and attachments.
- Queue integrity and delivery state.
- Suppression, unsubscribe, bounce, and complaint state.
- Admin session and update control.
- Audit log integrity.

### Trust Boundaries

- Public client to Core API.
- Core API to Redis.
- Worker to SMTP provider.
- Web panel to Core monitor endpoints.
- Runtime process to local SQLite vaults.
- Updater to git remote and npm registry.

### Primary Threats

| Threat | Control |
|---|---|
| Duplicate send from client retry | Idempotency key scope per tenant/actor |
| Mail loss after worker crash | Redis processing lease and requeue |
| SMTP credential disclosure | Encrypted SQLite vault, masking in UI, no `.env` SMTP secrets |
| Suppression bypass | Category based suppression for marketing/bulk |
| Unauthenticated production API | Production guard rejects `AUTH_MODE=none` |
| Public monitor leakage | Production guard requires `MONITOR_TOKEN` |
| Unsafe update path | Production guard requires tag mode and signed tag verification |
| Audit tampering | Hash chain over append-only audit records |

## Queue Topology

Default production queue is Redis with these keys:

- `REDIS_QUEUE_KEY`: pending jobs.
- `${REDIS_QUEUE_KEY}:processing`: jobs leased by workers.
- `${REDIS_QUEUE_KEY}:processing:leases`: sorted set of raw job payloads by lease expiry.

Worker lifecycle:

1. API writes validated job to pending queue.
2. Worker moves one job to processing with blocking pop/push.
3. Worker creates or refreshes the processing lease.
4. Worker sends mail and retries locally when needed.
5. Worker records `retrying`, `deferred`, `delivered`, `bounced`, `failed`, and `dead-lettered`.
6. Worker writes DLQ after final failure or logs success.
7. Worker acknowledges terminal job, removing processing and lease entries.
8. Reclaimer moves expired processing jobs back to pending.

Durability note: this gives at-least-once delivery. A crash after SMTP provider accepted a message
but before queue ack can still produce a duplicate. Production SMTP provider selection should use
provider-side custom message metadata or an outbox ledger if exactly-once business semantics are required.

## Retry Architecture

- Retry attempts are controlled by `RETRY_ATTEMPTS`.
- Base delay is `RETRY_DELAY_MS`.
- Worker uses exponential backoff plus jitter.
- Greylisting is classified and gets a longer deferred retry delay.
- Domain policies can reduce max attempts by recipient domain.
- Final failure writes DLQ with full job JSON and failure reason.
- Domain/account quotas are enforced from operational delivery events. For multi-node deployments,
  use shared operational storage or move the counter backend to Redis/OLAP before declaring global quotas.

## Security Architecture

Baseline controls:

- JWT or API key authentication on `/send`.
- Production fail-fast guard.
- Rate limiting on API and token endpoints.
- Secure web-panel password store in encrypted SQLite.
- CSRF protection, configurable local TOTP MFA, idle timeout, absolute timeout, session revoke, IP-bound cookies, and RBAC middleware.
- Nonce-based CSP for web-panel inline scripts/styles; no `unsafe-inline` fallback.
- Monitor token requirement in production.
- Hash-chained audit events for critical operational state.

Production deployment controls:

- Place admin panel behind VPN, private network, IP allowlist, or zero-trust gateway.
- Terminate TLS at a reverse proxy with HSTS.
- Use CSP nonce/hash policy on web panel pages before public exposure.
- Local TOTP MFA is disabled in the dev `.env` example but enforced by production guard; use an identity provider or WebAuthn/FIDO2 for phishing-resistant deployments.
- Keep update endpoints disabled or restricted to approved operators.

## Secret Management Architecture

Current repository behavior:

- SMTP account values are stored in encrypted SQLite, not `.env`.
- `.env` contains only high-level runtime configuration and encryption/auth secrets.
- `SECURE_STORE_KEY` or `SECURE_STORE_KEY_FILE` protects the encrypted vault.

Production target:

- Prefer `SECURE_STORE_KEY_FILE` or a platform secret mount over plain `.env`; KMS/Vault agents can write this file.
- Rotate the secure store key through an online re-encryption flow.
- Never log raw SMTP passwords, tokens, private keys, or updater credentials.
- Keep `.env` out of source control and restrict filesystem permissions.

## Deliverability Architecture

Implemented:

- `category` field: `transactional`, `security`, `notification`, `marketing`, `bulk`.
- Suppression applies to `marketing,bulk` by default.
- One-click unsubscribe links can be generated when `PUBLIC_BASE_URL` and `UNSUBSCRIBE_SECRET` are set.
- Bounce/complaint webhooks ingest provider events and update suppression.
- DKIM signing can be enabled with `DKIM_SIGNING_ENABLED=true`.
- Dedicated Return-Path is generated when `BOUNCE_DOMAIN` is set.
- Monitor endpoint checks SPF, DKIM selector TXT records, DMARC policy, MX, MTA-STS, and TLS-RPT.

Mandatory production controls:

- DNS records must still be published by domain owner before verification can pass.
- DMARC minimum `quarantine`; mature domains should move to `reject`.
- Provider FBL subscriptions must be configured so complaint webhooks receive real traffic.
- Warm-up profiles are configured through `DOMAIN_POLICIES_JSON`/`SMTP_ACCOUNT_POLICIES_JSON`; production warm-up dashboards still need real provider data.

## Monitoring Architecture

Current metrics:

- `mailfastapi_queue_depth`
- `mailfastapi_queue_processing_depth`
- `mailfastapi_active_jobs`
- `mailfastapi_mail_queued_total`
- `mailfastapi_mail_sent_total`
- `mailfastapi_mail_failed_total`
- `mailfastapi_mail_retry_total`
- `mailfastapi_delivery_events_1h_total{event="..."}`
- log level counters and auth token counters

Production stack:

- Prometheus scrape of `/metrics`.
- Grafana dashboard per tenant, account, domain, and worker group.
- Structured JSONL and SQLite logs shipped to central log platform.
- Alerting on queue flood, processing lease requeue spike, DLQ growth, SMTP outage, bounce spike,
  complaint spike, and worker crash loops.

## Deployment Topology

Minimum production:

```text
3 x Core API instances
10 x Worker instances
1 x Redis primary with persistence and managed failover
1 x private admin web panel instance
1 x Prometheus + Grafana stack
1 x centralized log sink
```

Rules:

- `MAILFASTAPI_ROLE=api` for API instances.
- `MAILFASTAPI_ROLE=worker` for worker instances.
- `PRODUCTION_MODE=true`.
- `QUEUE_BACKEND=redis`.
- Do not run `MAILFASTAPI_ROLE=all` in production.
- Do not run admin web panel on a public interface.

## CI/CD Security Model

Required gates:

- `npm test`
- Node syntax checks.
- Secret scan for committed `.env`, tokens, keys, and SMTP credentials.
- Dependency audit in CI.
- Signed release tag verification for production updater.
- Fast-forward-only updates.
- Rollback on failed dependency, syntax, test, restart, or health-check step.

## Disaster Recovery Strategy

- Redis persistence must be enabled and backed up.
- Encrypted secure SQLite vault must be backed up separately with key custody controls.
- Operational SQLite store must be backed up for suppression, idempotency, DLQ, and audit history.
- Restore order: secrets, operational DB, secure vault, Redis, API, workers, web panel.
- Recovery objective should be tested with worker crash and Redis restart drills.

## Runbook Set

### Queue Flood

1. Check `/metrics` for `mailfastapi_queue_depth` and processing depth.
2. Pause non-critical marketing tenants.
3. Scale worker instances.
4. Inspect SMTP provider throttling and DLQ.
5. Keep API backpressure enabled; do not bypass queue full responses.

### SMTP Outage

1. Identify affected SMTP account from logs and monitor account view.
2. Stop routing new traffic to that account.
3. Keep jobs queued while outage is active.
4. After provider recovery, re-enable workers gradually.
5. Review DLQ and requeue only when safe.

### Suppression Incident

1. Confirm source: hard bounce, complaint, unsubscribe, or manual.
2. Export affected tenant rows from operational DB.
3. Do not remove complaint suppressions without compliance approval.
4. Add audit note for manual changes.

### Update Failure

1. Check updater status page and `data/updater.lock`.
2. Confirm rollback commit.
3. Run `npm test`.
4. Check `/health` for core and web services.
5. Reattempt only with signed release target.

## Incident Response Plan

1. Triage severity: data exposure, credential exposure, deliverability outage, or update compromise.
2. Contain: disable web updater, rotate tokens, stop affected SMTP account, block tenant if needed.
3. Preserve evidence: logs, audit events, updater logs, git commit/tag, process environment snapshot.
4. Eradicate: patch, rotate secrets, remove malicious release/artifact.
5. Recover: restore services, replay safe queue/DLQ items, validate domain health.
6. Post-incident: root cause, timeline, customer impact, corrective controls.

## Scaling Strategy

- Scale API horizontally on request rate and auth/token latency.
- Scale workers on queue depth, processing depth, SMTP latency, and provider throttling.
- Use separate SMTP accounts and dedicated IP pools for transactional/security vs marketing/bulk.
- Keep tenant isolation with tenant IDs in idempotency, suppression, metrics, and audit records.
- Add Redis Cluster or RabbitMQ/Kafka when Redis single-primary operational limits are reached.

## Hardening Checklist

- [ ] `PRODUCTION_MODE=true`.
- [ ] `AUTH_MODE` is not `none`.
- [ ] `MAILFASTAPI_ROLE` is `api` or `worker`, never `all`.
- [ ] `QUEUE_BACKEND=redis`.
- [ ] Redis persistence and failover are configured.
- [ ] `MONITOR_TOKEN` is set.
- [ ] Web panel is private-network only.
- [ ] `SECURE_STORE_KEY` is loaded from secret manager.
- [ ] `UPDATER_RELEASE_MODE=tag`.
- [ ] `UPDATER_REQUIRE_SIGNED_TAG=true`.
- [ ] SMTP passwords are stored only in encrypted vault.
- [ ] Suppression backup and restore tested.
- [ ] DKIM, SPF, DMARC verified for every sending domain.

## Production Readiness Checklist

- [ ] Worker restart test passes with no silent data loss.
- [ ] Redis restart test passes with persisted pending jobs.
- [ ] Duplicate idempotency replay test passes.
- [ ] DLQ insert and recovery workflow tested.
- [ ] Queue flood test produces predictable backpressure.
- [ ] SMTP outage test does not lose jobs.
- [ ] Admin panel cannot be reached from public internet.
- [ ] Metrics are scraped and alerts fire.
- [ ] Restore drill completed.

## Security Verification Checklist

- [ ] MFA bypass test.
- [ ] RBAC privilege escalation test.
- [ ] CSRF test on every state-changing web action.
- [ ] CSP validation.
- [ ] Session idle and absolute timeout test.
- [ ] Secret leakage scan.
- [ ] Signed tag verification test.
- [ ] Dependency supply-chain scan.

## Deliverability Verification Checklist

- [ ] SPF alignment test.
- [ ] DKIM valid and invalid signature tests.
- [ ] DMARC alignment test.
- [ ] Gmail/Yahoo bulk sender requirement review.
- [ ] Hard bounce simulation.
- [ ] Complaint workflow simulation.
- [ ] One-click unsubscribe test.
- [ ] Warm-up and throttling behavior test.

## Load Test Report Template

```text
Date:
Commit:
Environment:
API instances:
Worker instances:
Redis profile:
SMTP provider/profile:

Scenario:
Target TPS:
Duration:
Tenant mix:
Mail category mix:

Results:
P50/P95/P99 API ACK latency:
Queue depth max:
Processing depth max:
Worker throughput:
SMTP latency P50/P95/P99:
Retry count:
DLQ count:
Bounce/complaint count:
Errors:

Conclusion:
Capacity limit observed:
Next scaling action:
```

## Chaos Test Scenarios

| Scenario | Expected result |
|---|---|
| Kill one worker during SMTP send | Job remains processing until lease expiry, then requeues |
| Kill all workers | API continues enqueueing until queue/backpressure limit |
| Restart Redis with persistence | Pending jobs survive restart |
| SMTP provider timeout | Worker retries with backoff and jitter |
| Poison job | Final failure goes to DLQ and audit/log record exists |
| Web updater interrupted | Lock prevents concurrent update; rollback or manual recovery path is clear |
| High-volume tenant flood | Other tenants remain observable; backpressure activates |

## Compliance Mapping

| Standard | Repository control |
|---|---|
| OWASP ASVS L2 auth/session | JWT/API-key auth, web sessions, CSRF, rate limiting |
| OWASP ASVS L2 secrets | Encrypted SMTP vault, no SMTP credentials in `.env` |
| OWASP API Security Top 10 | Auth, rate limits, payload validation, production guard |
| NIST SP 800-63B | Local TOTP MFA implemented; WebAuthn/FIDO2 or IdP MFA recommended for AAL3/phishing resistance |
| NIST SSDF SP 800-218 | Signed update model, tests, rollback, supply-chain gate plan |
| OWASP Secrets Management | Secret minimization and external secret-manager target |
| Google/Yahoo bulk sender | Unsubscribe, suppression, complaint ingestion, DKIM config, domain health diagnostics |

## Phase Status

| Phase | Status |
|---|---|
| Queue and distributed delivery | Core implemented; provider-specific exactly-once remains external/business dependent |
| Rate limiting and reputation | API limits plus domain/account policy counters implemented; provider reputation telemetry remains external |
| Bounce/suppression/complaint | Classifier, hard-bounce suppression, complaint webhook, global/tenant suppression implemented |
| Security hardening | Production guard, audit, CSRF, secure store, local TOTP MFA, RBAC middleware, session revoke, nonce CSP implemented; WebAuthn/IdP MFA remains external |
| Mail auth/deliverability | SPF/DKIM/DMARC/MX/MTA-STS/TLS-RPT checks, DKIM signing config, Return-Path separation implemented; DNS publication remains external |
| Observability/operations | Metrics and monitor exist; tracing/alert stack remains deployment work |
| Load/stress/chaos | Templates and scenarios defined; production benchmark must run on target infra |
| Compliance | Mapping defined; ASVS L3 requires external identity/network/secret controls |
