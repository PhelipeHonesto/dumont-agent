# Audit 06 — Query Efficiency (ln-651) — 2026-04-17

Scope: redundant fetches, N-UPDATE loops, over-fetching, bulk ops,
caching scope across `src/`. Raw SQL via `pg` + `better-sqlite3`; no
ORM, so ORM-specific checks (like `expire_on_commit`, `load_only`)
don't apply directly.

## Score: **7.5 / 10**

The hot paths are already bulk-optimized (`bulkUpsert` used 46×,
chunk-based ingestion). One real N-UPDATE loop in safety-ratings, a
handful of `SELECT *` reads that aren't worth tightening, and good
worker-scoped caches with TTL refresh.

## Summary counts

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Moderate | 2 |
| Low | 2 |
| Informational | 2 |

## Findings

### F-06-1 — N-UPDATE loop in `safety-ratings.ts`

**Severity:** MODERATE · **Location:** `src/ingestion/safety-ratings.ts:136-164`
· **Effort:** M

```ts
for (const rating of ratings) {
  const matches = allOperators.filter((op) => fuzzyMatch(inputName, op.name));
  // ...
  for (const match of matches) {
    await updateOp.run(
      rating.argus_rating ?? null,
      rating.wyvern_rating ?? null,
      rating.is_bao_stage ?? null,
      now,
      match.certificate_number,
    );
    matchedCerts.add(match.certificate_number);
  }
}
```

Each rating + matched operator pair hits Postgres with its own
`UPDATE`. With ~hundreds of ratings × 1–3 matches each, this round-trips
to Supabase many times.

**Recommendation:** bucket updates by rating value, then one
`UPDATE faa_operators SET argus=$1, wyvern=$2, is_bao=$3, updated_at=$4
WHERE certificate_number = ANY($5::text[])` per distinct
(argus/wyvern/bao) triple. Script runs once when safety ratings
change, so the optimization is mostly about operational courtesy to
the Supabase plan, not hot-path latency.

### F-06-2 — Sentry `tracesSampleRate: 0.1` but no span creation

**Severity:** MODERATE · **Location:** `src/utils/sentry.ts:85`
· **Effort:** S

Same issue called out in Audit 03 F-03-4, duplicated here because it
blocks useful query-latency metrics: we've opted into Sentry
Performance at 10% sample rate but never start transactions, so DB
query times aren't observable. Adding the `@sentry/node`
Express auto-instrumentation would unblock "slow route" visibility
without touching application code.

### F-06-3 — `SELECT *` in 24 places — mostly benign

**Severity:** LOW · **Effort:** S per site (not worth it)

Breakdown:
- Single-row `.get()` reads by primary key / unique key — **18 sites**,
  fine (column width doesn't matter for one row).
- Small-table `.all()` reads (operator_profiles, route_intel,
  client_profiles, fleet_stats) — **6 sites**, rows count in the
  thousands max, and callers use the full row shape for mapping.

No pagination + `SELECT * FROM deals` sort of thing spotted. The
ingestion hot paths use targeted column lists.

**Recommendation:** leave alone. If any of these tables grow to
millions of rows, revisit.

### F-06-4 — Bulk ops are the default, not the exception

**Severity:** — · **Location:** `src/memory/bulk-upsert.ts` + 11 usage
files, 46 call sites

- `bulkUpsert()` generates a single multi-valued `INSERT` with
  `ON CONFLICT DO UPDATE`, handles chunking internally.
- `faa-daily-diff.ts` chunks deregistered tails into 5,000-item
  `UPDATE ... WHERE tail_number IN (...)` batches — no N-UPDATE.
- `history-backfill.ts` processes 500 trace files per chunk, then
  issues two bulk writes (aircraft upsert + legs insert).
- `adsblol-live-worker.ts` and `opensky-worker.ts` bulk-write every
  polling cycle.

This is the strongest part of the codebase's DB posture. ✓

### F-06-5 — Worker caches are app-scoped with TTL refresh

**Severity:** — · **Location:** workers

Both live feed workers (`opensky-worker.ts`,
`adsblol-live-worker.ts`) load FAA lookup caches once at start, then
refresh on an interval (`FAA_REFRESH_INTERVAL_MS = 3_600_000` — every
hour). Caches are closed over in the worker closure, so they're
worker-scoped (effectively app-scoped for the life of that process)
— not per-request. ✓

Matches the "wrong caching scope" rule's *correct* pattern.

### F-06-6 — No redundant entity-fetch pattern

**Severity:** — · n/a

Spot-checked stores (`deal-store.ts`, `composite-stores.ts`,
`knowledge-graph.ts`): methods that take an ID fetch once and return
the row; callers keep the row object and don't re-resolve it later.
No `getX(id) → doX(id) → getX(id) again` chains observed.

### F-06-7 — MCP tools use parameterized single-row reads

**Severity:** INFORMATIONAL · **Location:** `src/mcp/tools.ts`

The 12 MCP tools do single `WHERE tail_number = ?` or similar
per-request queries with `.get()`. With stdio MCP traffic at most a
handful of tool calls per conversation, current pattern is fine.

### F-06-8 — CLI eval scripts use `.iterate` / Cursor where row count is large

**Severity:** INFORMATIONAL

`src/ingestion/package-positions.ts` uses `pg-cursor` for positions
streaming (row counts in the millions). `src/ingestion/parquet-ingest.ts`
uses `better-sqlite3`'s `.iterate()` for CSV→DB batched inserts. Both
avoid loading everything into memory. ✓

## Fix priority

1. **F-06-1 (safety-ratings N-UPDATE)** — when this script next runs
   (whenever we add new ratings), rewrite the loop. Until then,
   current runs complete in seconds anyway.
2. **F-06-2 (Sentry spans)** — tie to Audit 03 F-03-4; one fix covers
   both.

## What already works well

- `bulkUpsert` is pervasive — 46 call sites across ingestion,
  analytics, workers.
- Chunked deletes/updates in `faa-daily-diff` and `history-backfill`.
- Worker FAA caches refreshed hourly instead of per-cycle.
- pg-cursor streaming for row counts in the millions.
- No N+1 JOIN anti-patterns (code uses explicit LEFT JOIN queries via
  `pg` where joins are needed).
