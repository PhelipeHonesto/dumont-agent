# Audit 03 — Observability (ln-627) — 2026-04-17

Scope: structured logging, health endpoints, metrics, tracing, log
levels across `src/`.

## Score: **6.5 / 10**

Phase 15 Step 1 + Step 2 put structured logging and Sentry error capture
in place cleanly. Big gaps remain in request-tracing (no correlation IDs)
and metrics (no Prometheus/StatsD). Health endpoints exist but are thin.

## Summary counts

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Moderate | 3 |
| Low | 2 |
| Informational | 1 |

## Findings

### F-03-1 — `/health` endpoint is too shallow for real liveness

**Severity:** HIGH · **Location:** `src/server/routes/health.ts:11-17`
· **Effort:** S

Current `/health` is hardcoded:
```ts
res.json({ status: "ok", uptime: ..., version: "0.1.0" });
```

No downstream reachability check — if Postgres goes down, `/health`
still returns 200 and PM2 / future load balancer won't know. Deeper
health data exists at `/api/health/data`, `/api/health/feed`,
`/api/health/quality` (good — Phase 15-era work), but the liveness
endpoint itself doesn't exercise any dependency.

**Recommendation:** keep `/health` as cheap always-OK (liveness), but
add a `/ready` readiness probe that runs a `SELECT 1` against Postgres
(fast, 2s timeout) and returns 503 if it fails. Point PM2 / Lightsail
health checks at `/ready`; keep `/health` for the human dashboard.

### F-03-2 — No request IDs / correlation IDs

**Severity:** MODERATE · **Location:** absent — `src/server/index.ts`
middleware chain · **Effort:** S

Zero references to `requestId`, `correlationId`, `x-request-id`,
`trace-id` anywhere in `src/`. When an error lands in Sentry it has the
component and err.stack, but no way to correlate to an individual HTTP
request or to cross-reference with Vapi call logs.

For a single-service deploy this is *tolerable*, but debugging
production incidents at 3 AM gets dramatically faster with a request
ID in every log line and in the 500 response body.

**Recommendation:**
1. Add middleware that reads `X-Request-ID` header (or generates a ULID)
   and attaches it to `req` + a pino child logger.
2. Include it in every `log.*` call via child binding.
3. Return it in error responses so users can quote it when reporting bugs.

Rough implementation (~20 lines), bindings propagate for free via pino
child loggers. **Effort:** S.

### F-03-3 — No metrics instrumentation

**Severity:** MODERATE · **Location:** absent · **Effort:** M

No `prom-client`, `StatsD`, `CloudWatch`, or `@opentelemetry/*` in
`package.json`. The Dumont API has no p95 latency, no request-rate
counter, no DB query timing, no error-rate gauge. All we have is the
errors.log file + Sentry issue count.

**Recommendation:** defer until after first deploy. Once we're in
production and paging on "is it slow?" matters, add `prom-client` with
histograms for request duration by route + counter for error status.
Scrape with a small external agent or push to Grafana Cloud free tier.

**Effort:** M (1 hr to bootstrap, several hours to instrument
meaningfully).

### F-03-4 — Sentry covers error-level alerting but not performance tracing

**Severity:** MODERATE · **Location:** `src/utils/sentry.ts:85-92`
· **Effort:** S

Phase 15 Step 2 ships `tracesSampleRate: 0.1`, which Sentry uses for
performance monitoring — but we never call `Sentry.startSpan` or
`Sentry.startTransaction` anywhere in the codebase, so that 10% sampling
is effectively no-op. Performance data doesn't flow to Sentry without
explicit transaction boundaries.

**Recommendation:** either (a) wrap Express with
`@sentry/node`'s Express integration to get auto-transactions on every
route, or (b) drop `tracesSampleRate` to 0 and disable the "performance"
illusion. (a) is better because then F-03-3 is partially solved for free.

### F-03-5 — 554 remaining `console.*` calls

**Severity:** LOW · **Scope:** 40 files · **Effort:** L (cumulative)

The Phase 15 Step 1 work deliberately left pretty CLI output as
`console.log` per the Step 5 rule (progress counters, summary tables,
Usage text). The 554 residual calls split roughly:

- **Summary tables** in CLI scripts (`═══` banners, padded rows) —
  40% of the count.
- **Per-loop progress counters** in ingestion (`processing N/M files`) —
  30%.
- **Usage text** on `--help` or bad CLI args — ~50 calls.
- **`✓` / `✗` success lines** from `pipeline.runStep`.
- **A few genuine info events** that were skipped to keep the Phase 15
  rewrite scoped — flagged individually in each tier report.

None of these is on a production error path. PM2 still captures them
via stdout + stderr, so they're available in `~/.pm2/logs/*` just as
before; the difference is they're line-oriented pretty text rather than
JSON.

**Recommendation:** continue to live with it. If you want to fully JSON
the logs for a log-shipping pipeline later, convert on-demand when you
touch each file for another reason. No bulk rewrite needed.

### F-03-6 — Log levels are used appropriately

**Severity:** — · **Location:** cross-repo

pino child loggers use the full level set:
- `info` — worker start/stop, cycle complete, row counts, download
  progress
- `warn` — HTTP retries, missing-file skips, rate-limit hits
- `error` — per-day failure, catch-block handlers, connection issues
- `fatal` — `main().catch()` handlers + unhandled-rejection / uncaught-
  exception process handlers

Level filtering works via `LOG_LEVEL` env var. ✓

### F-03-7 — `LOG_LEVEL` env var defaults to `info` in prod

**Severity:** INFORMATIONAL

Default is acceptable. `debug` has to be explicitly turned on. If
debug-level logs become useful later (request parameters, SQL queries),
consider wiring a kill-switch into `/api/admin/set-log-level` so we can
flip without a restart.

## Fix priority

1. **F-03-1** (/ready endpoint) — tiny, high leverage. Do before deploy.
2. **F-03-2** (request IDs) — ~20 LOC, dramatically speeds up incident triage.
3. **F-03-4** (Sentry transactions or drop tracesSampleRate) — quick fix.
4. **F-03-3** (Prometheus) — defer to post-deploy.
5. **F-03-5** (remaining console.*) — don't chase.

## What already works well

- Structured pino logs across cron-facing layers (commits
  ae51236, 6f8c640, 9794a26, 5b60a8d).
- Sentry error/fatal bridge with per-component tagging and secret
  scrubbing (7b2bc7e).
- Five health endpoints (`/health`, `/api/health/data`,
  `/api/health/feed`, `/api/health/quality`, `/api/health/errors`).
- Process-level handlers for `uncaughtException` and
  `unhandledRejection` in all five long-running entry points.
- Error-tracker middleware with file rotation at 1 MB.
