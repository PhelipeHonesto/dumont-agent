# Phase 15 Step 1 — Structured logging (pino)

> **Step 2 shipped**: `error` and `fatal` events now bridge to Sentry via
> a pino `logMethod` hook. See `docs/phase15-step2-sentry.md` for setup,
> verification, and the auto-triage pattern.


## Why pino

JSON-native, ~5x faster than winston under load, used by Fastify + NestJS
by default. Zero-config for the common case; transport system handles
dev pretty-printing without polluting prod output.

## What shipped (Tier 1 foundation)

- `src/utils/logger.ts` — exports `logger` and `childLogger(component)`.
- `tests/logger.test.ts` — 4 tests covering existence, child inheritance,
  level filtering, error serialization.
- `src/ingestion/opensky-worker.ts` — worked example conversion (all 13
  `console.*` calls → `log.*`).
- `package.json` — `pino` (dep), `pino-pretty` (devDep).

## Remaining work

Tier-by-tier conversion of the rest of the codebase. See "Scope" table
below. Each tier: its own commit, typecheck + tests between.

## Logger configuration

| Variable | Default | Effect |
|----------|---------|--------|
| `LOG_LEVEL` | `info` | Minimum level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `NODE_ENV` | _unset_ | When `production`, JSON output. Otherwise pretty-print if stderr is a TTY |

Logs always go to **stderr**. Stdout is reserved for data (MCP stdio
protocol + CLI summary tables). PM2 captures stderr identically.

## Usage

```ts
import { childLogger } from "../utils/logger.js";
const log = childLogger("faa-daily-diff");

log.info({ rows: 12345, duration_ms: 4200 }, "diff complete");
log.warn({ tail_number, reason: "missing_icao" }, "aircraft skipped");
log.error({ err, context: { date } }, "processing failed");
log.fatal({ err }, "unrecoverable error");
```

Structured fields go in the object; the string is the human-readable
description. Queryable data lives in the fields (`rows`, `duration_ms`,
`tail_number`), not interpolated into the message.

## Levels

- `debug` — verbose internal state (off in prod by default)
- `info` — normal operational events (row counts, completions)
- `warn` — unexpected but recoverable (missing tar, retry, skipped row)
- `error` — operation failed, recoverable with intervention
- `fatal` — unrecoverable, process should exit

## Errors

Pass via the `err` field. Pino's default serializer captures `type`,
`message`, and `stack` automatically:

```ts
log.error({ err }, "operation failed");           // RIGHT
log.error(err.message);                            // WRONG — loses stack
```

## Sample output

### Production (JSON)
```
{"level":30,"time":1776401765837,"service":"osa-dumont","version":"0.1.0","component":"demo","rows":12345,"duration_ms":4200,"msg":"diff complete"}
```

### Dev (pretty-printed when stderr is a TTY)
```
[23:56:24.814] INFO: diff complete
    service: "osa-dumont"
    version: "0.1.0"
    component: "demo"
    rows: 12345
    duration_ms: 4200
```

## Step 5 rule — when to keep `console.log`

Deliberately pretty CLI output stays as `console.log`:
- Progress updates in loops (`Processed 5000/28453 files`)
- Summary tables at end of runs (the `═══ Summary ═══` blocks)
- Interactive confirmation banners
- Passthrough from spawned processes (curl, tar, unzip)

Switch to logger:
- "Event happened" lines (downloading, writing, complete)
- All error paths (always — no exceptions)
- Structured operation results (counts, durations, IDs)

Rule of thumb: if you'd want to `grep` or `jq` this in production logs
later, it's a logger call. If it's visual formatting for a human at a
terminal, it's `console.log`.

## Querying logs with jq

```
# All errors in the last hour (PM2 logs)
tail -f ~/.pm2/logs/*.log | jq 'select(.level >= 50)'

# Specific component
tail -f ~/.pm2/logs/*.log | jq 'select(.component == "opensky")'

# Slow operations
tail -f ~/.pm2/logs/*.log | jq 'select(.duration_ms > 5000)'

# Aggregate by component
jq -s 'group_by(.component) | map({component: .[0].component, count: length})' < opensky.log

# All warnings for a specific aircraft
jq 'select(.tail_number == "N788QS" and .level == 40)' < pipeline.log
```

## PM2 log rotation

Install the rotation module once on the Lightsail host:

```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

## Coverage status

Phase 15 Step 1 targeted **production-critical error paths only** (fatal
handlers, catch-block errors, retry/warning paths, worker lifecycle),
not a full 750+ call rewrite. CLI summary tables, progress counters,
and Usage text stay as `console.log` per the Step 5 rule.

| Tier | Path | Files touched | Error/warn converted | Status |
|------|------|---------------|----------------------|--------|
| 1 | `src/ingestion/` | 18 | ~40 | done (commits 6f8c640, ae51236) |
| 2 | `src/server/` + `src/mcp/` | 7 | 10 | done (commit 9794a26) |
| 3 | `src/memory/` + `src/analytics/` + `src/eval/` | 7 | ~15 | done (this commit) |

Info/debug-level events (e.g., `[opensky] caches loaded…`,
`[archive] ${date}: done` lines) **remain as `console.log`** in most
files. Convert them opportunistically in future work if structured
per-event telemetry becomes useful.

Excluded deliberately:
- `src/ingestion/history-backfill.ts` (recent commit ad1b681)
- `scripts/s3-bulk-restore.ts` (recent commit d2844c8)
- `scripts/*` (dev-only CLIs, pretty output is the point)
- `src/integrations/`, `src/orchestrator/`, `src/run-sim.ts`,
  `src/scripts/seed-db.ts`, `src/utils/safe-llm-call.ts`,
  `src/monitoring/health-check.ts` — mostly single-line legacy
  `console.error` calls; convert when touched for other reasons.

## Upgrade path

- **Step 1** (this commit) — structured logging foundation
- **Step 2** — Sentry integration for error capture + alerting
- **Step 3** — uptime monitoring (status page, HTTP healthchecks)
