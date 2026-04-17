# Phase 15 Step 1 — Structured logging (pino)

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

## Scope — what's converted and what's pending

| Tier | Path | Files | Approx console.* | Status |
|------|------|-------|------------------|--------|
| 1 | `src/ingestion/` | 22 | ~445 | 1 file done (opensky-worker) — **pending** |
| 2 | `src/server/` | 5 | ~15 | pending |
| 3 | `src/mcp/` | 2 | ~6 | pending |
| 4 | `src/memory/` | 3 | ~44 | pending |
| 5 | `src/analytics/` | 3 | ~25 | pending |
| 6 | `src/eval/` | 1 | ~21 | pending |
| 7 | `scripts/` | 4 | ~118 | pending |

Excluded (per instruction):
- `src/ingestion/history-backfill.ts` (just committed in ad1b681)
- `scripts/s3-bulk-restore.ts` (just committed in d2844c8)

## Upgrade path

- **Step 1** (this commit) — structured logging foundation
- **Step 2** — Sentry integration for error capture + alerting
- **Step 3** — uptime monitoring (status page, HTTP healthchecks)
