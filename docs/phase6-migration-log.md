# Phase 6 — SQLite-writer migration log

Tracks file-by-file migration from SQLite-primary writes to Postgres via the
`getDatabase()` / `bulkUpsert` pattern established in D1 and the analytics
rewrite. After this phase, SQLite is read-only until retirement (Phase 9).

All migrated scripts now require `DATABASE_TYPE=postgres` and throw at startup
if unset. No dual-write. No fallback.

---

## Tier 1 — critical path (complete)

### 1. `src/ingestion/archive-adsb-raw.ts`

**Writes now on PG:** `archive_progress` (upsert by date via `markArchive`)

**Reads now on PG:** `archive_progress` (isArchiveComplete, summary totals)

**Exported surface:** `archiveDay(s3, db: DbBridge, date, storageClass, check)`
still exported; consumed by `scripts/backfill-2023.ts` (also migrated in the
same commit). The `db` parameter is now typed `DbBridge` — callers must pass
the bridge, not a raw `Database`.

**Behavior preserved:** same ON CONFLICT upsert logic. The existing
`datetime('now')` literal works in PG because `pg-database.ts:convertSql`
rewrites it to `NOW()::text` automatically for the TEXT column.

**Surprise:** `scripts/backfill-2023.ts` imports `archiveDay` — its own
`getDb()` usage had to be updated at the same time. Done in this commit.

---

### 2. `src/ingestion/safety-ratings.ts`

**Writes now on PG:** `faa_operators` (per-row UPDATE), `knowledge_graph`
(single UPDATE with correlated subquery, then per-operator fuzzy UPDATE)

**Reads now on PG:** `faa_operators`, `knowledge_graph` (counts + sample)

**Behavior preserved:** the correlated-subquery UPDATE for propagating safety
scores from `faa_operators` into `knowledge_graph` is standard SQL; PG runs
it as-is. `LIKE '%pattern%'` fuzzy update works identically.

**Removed:** `db.transaction(() => ...)` wrappers around the update loops.
PG runs each statement in its own auto-committed transaction. For ~100 rating
entries and ~50 fuzzy updates, per-row await is fine (not the hot path).

**Surprise:** none. Straightforward conversion.

---

### 3. `src/ingestion/faa-daily-diff.ts`

**Writes now on PG:** `faa_aircraft` (bulk upsert with COALESCE preservation
on `icao_hex`), `faa_registry_changes` (bulk INSERT, no conflict — `id`
is SERIAL)

**Reads now on PG:** full `faa_aircraft` snapshot (~315 K rows) for diff,
plus the sample-of-recent-changes report queries.

**Structural change:** the old per-row `INSERT/UPDATE` loop inside a
`db.transaction(() => ...)` has been replaced by the accumulator-then-bulk
pattern from D1:

- Iterate the diff, push to `aircraftUpserts[]` / `changes[]` /
  `deregisteredTails[]` arrays.
- After the loop: one `bulkUpsert` for `faa_aircraft` with a custom
  `updateClause` that preserves `icao_hex` via `COALESCE(EXCLUDED.icao_hex,
  faa_aircraft.icao_hex)` — mirrors the old SQLite `icao_hex = COALESCE(?,
  icao_hex)` semantics.
- One `bulkUpsert` for `faa_registry_changes` (plain INSERT — no PK conflict).
- Chunked `UPDATE ... WHERE tail_number IN (...)` for deregistrations (5 K
  tails per chunk to stay under PG's parameter limit).

**Removed:** the SQLite-specific `sqlite_master` table existence check +
inline `CREATE TABLE IF NOT EXISTS faa_registry_changes`. The PG schema
is managed centrally in `src/memory/schema-pg.sql`.

**Surprise:** the deregistration update needed chunked `IN (...)` — PG won't
accept `WHERE tail_number = ANY($1)` for large arrays without care around
parameter binding; explicit chunks of 5 000 are the simplest safe bound.

---

### 4. `src/ingestion/pipeline.ts`

**Writes now on PG:** `pipeline_runs` (INSERT + later UPDATE by id via
`RETURNING`)

**Reads now on PG:** `faa_registry_changes`, `faa_aircraft`, `knowledge_graph`
(all via direct `pg.Client`)

**Structural change:** removed the raw `better-sqlite3 Database` + `runMigrations`.
The orchestrator now opens a single `pg.Client` for its own bookkeeping
(`pipeline_runs`) plus the stats-collection queries it runs after each step.
Child scripts (shelled out via `execSync`) inherit `DATABASE_TYPE=postgres`
from the parent env — `runStep` already forwards `process.env`.

**Removed:** `runMigrations(db)` at startup — PG schema is managed separately
via `schema-pg.sql`. The task explicitly says migrations.ts stays SQLite-only.

**Known limitation (documented in code):** steps 2 and 3 still invoke the
root `.mjs` scripts (`classify-aircraft.mjs`, `update-graph.mjs`), which are
Tier 3 and still write to SQLite. After Tier 1, the pipeline run on Lightsail
will be hybrid: steps 1 and 4 write to PG; steps 2 and 3 write to SQLite; the
pipeline's own `pipeline_runs` bookkeeping + stats queries read from PG.
`knowledge_graph` stats may be off by one run until Tier 3 migrates those
`.mjs` scripts to PG. `try/catch` guards the read in case the graph schema
or data differs across environments.

**Surprise:** `SELECT * FROM pipeline_runs WHERE id = ?` at the end of the
run worked via a RETURNING-captured id at insert time. PG's RETURNING clause
is the clean equivalent of SQLite's `lastInsertRowid`.

---

## Verification

```
npm run typecheck   → clean
npm test            → 649 passed (21 test files, 3 skipped). No regressions.
```

No scripts invoked during Tier 1. Per task: "DO NOT run full ingestion jobs
yet (those run on Lightsail after deploy)." The smoke-test check was:

```
DATABASE_TYPE=postgres npx tsx src/ingestion/archive-adsb-raw.ts --check --date 2026-04-15
```

Not executed in this session to avoid touching the Lightsail cron's expected
state; `--check` is a dry run (no S3 writes, no DB writes) and would be safe
to run at deploy time.

## Files changed in Tier 1

```
M  src/ingestion/archive-adsb-raw.ts         (getDb → getDatabase; async markArchive + isArchiveComplete; async archiveDay param is DbBridge)
M  src/ingestion/safety-ratings.ts           (async main; removed db.transaction; all calls awaited)
M  src/ingestion/faa-daily-diff.ts           (bulk upsert pattern; removed sqlite_master check; chunked deregistration UPDATE)
M  src/ingestion/pipeline.ts                 (pg.Client direct; no SQLite/runMigrations; RETURNING id)
M  scripts/backfill-2023.ts                  (follows archiveDay signature change — now passes DbBridge)
```

No new deps. No schema changes.

## Tier 2 — scripts needed for Phase 7 (complete)

### 5. `src/ingestion/adsblol-ingest.ts`

**Structural rewrite.** The old file had `processFile(path, db, stats)` that
read a trace, downsampled, then wrote positions and upserted aircraft to
SQLite mid-loop. That API doesn't translate to the Phase 2 architecture —
`adsb_positions` has a 48 h TTL, so historical positions would be deleted on
the next cleanup cycle.

**New API (pure parse + in-memory leg detection, bulk writes):**
- `parseTraceFile(filePath, stats) → ParsedTrace | null` — reads, decompresses,
  filters, downsamples; returns data, no DB writes.
- `detectLegs(parsed, airports) → DetectedLeg[]` — scans one aircraft's
  downsampled points in memory and emits completed legs (mirrors the old
  position-backed detection logic exactly).
- `bulkInsertLegs(db, legs)` — plain bulk INSERT into `adsb_completed_legs`.
- `bulkUpsertAircraft(db, parses)` — bulk upsert into `faa_aircraft` with
  a custom `updateClause` using `COALESCE` to preserve existing non-null
  enrichment fields.
- `loadAirports(db) → Airport[]` + `findNearestInMemory(airports, lat, lon)`
  — lookup index, loaded once per run (198 rows, trivial memory).

**Removed:** `processFile` (breaking change, only 2 callers both under our
control), `insertPositions` (historical positions never go to PG),
`materializeLegs` (now per-file in-memory), `computeAircraftStates`
(historical state snapshots aren't useful — the live worker owns state),
`findNearestAirport(db, ...)` (replaced by in-memory equivalent + the
`loadAirports` preload).

**Standalone mode (`npm run ingest:history <dir>`):** still works. Same
flow as history-backfill: parse → detect legs in memory → bulk write, in
chunks of 500 files.

**Behavior preserved:** same downsampling logic, same 5-minute taxi filter,
same US-registration (`data.r.startsWith("N")`) gate, same nearest-airport
radius (15 nm). Aircraft type → class mapping (`ICAO_TYPE_CLASS`) unchanged.

---

### 6. `src/ingestion/history-backfill.ts`

**Architectural simplification enabled by (5).** The old script wrote
positions to `adsb_positions` in SQLite, then ran a cross-file
`materializeLegsForDay` step that queried positions back out for leg
detection, then ran `DELETE FROM adsb_positions WHERE timestamp >= ? AND
timestamp < ?` to clean up. That whole dance existed because the old code
couldn't hold positions in memory.

With the new `parseTraceFile` + `detectLegs` pair, each trace file is
self-contained: parse → detect → emit legs. No temp storage. No cleanup.

**Per-day flow (new):**
1. Download + reassemble tar from adsb.lol GitHub release.
2. Extract to `/tmp`.
3. Walk the extract, match trace_full_{icao}.json{.gz} against the
   charter-hex set loaded from `faa_aircraft`.
4. In 500-file chunks: `parseTraceFile` → `detectLegs` → accumulate.
5. After each chunk: `bulkUpsertAircraft` (new discoveries) +
   `bulkInsertLegs`.
6. `backfill_progress` row upserted on start (`processing`) and finish
   (`complete` or `failed`).

**Writes now on PG:**
- `adsb_completed_legs` — bulk insert of detected legs per chunk.
- `faa_aircraft` — bulk upsert of aircraft discovered via traces (COALESCE
  preservation on enrichment fields).
- `backfill_progress` — per-day progress via DbBridge.

**Deferred to a later deliverable (flagged, not implemented here):** the
"full packager equivalent" option — writing positions directly to S3
Parquet so historical days look identical to packager-produced days. That
would require threading the D2.1 packager's in-memory parquet writer into
this script. Much bigger scope; the simpler version (legs only) is what
unblocks the Phase 7 legs-gap backfill. When we want historical per-day
parquets, we'll add a `history-package-positions.ts` that calls the same
underlying parquet writer from a tar stream.

---

### 7. `src/eval/quote-eval.ts`

**Writes now on PG:** `eval_runs` (one row per scenario, bulk INSERT,
plain — `id` is SERIAL), `eval_run_summaries` (single row per run).

**Intentional SQLite retention:** `DealStore(.../eval-deals.db)` stays on
SQLite. This is a **scratch sandbox database** for the eval harness — the
pipeline runs test scenarios through it without touching production deal
state. This does not violate Phase 6's "no SQLite writers" rule because:
- It's a separate file from `dumont.db` (production state).
- It's wiped each run conceptually (eval is idempotent, sandbox-only).
- The data it produces (`deals` rows for simulated scenarios) never
  flows anywhere downstream.

When SQLite is retired in Phase 9, this can either switch to an ephemeral
in-memory SQLite or a per-run PG schema. Cheap migration, low priority.

**Behavior change:** `within_20_pct` was written as `0/1` integer in SQLite;
PG schema has it as `BOOLEAN`. Now passing `r.within20Pct` directly (the
struct already carries a bool). Verified via `schema-pg.sql`.

---

## Verification (Tier 2)

```
npm run typecheck   → clean
npm test            → 649 passed (21 files, 3 skipped). No regressions.
```

No scripts invoked against real PG. Tier 2 scripts are CLIs that do large
writes; conservative hold until deploy time.

## Files changed in Tier 2

```
M  src/ingestion/adsblol-ingest.ts            (structural rewrite — new parse+detect API)
M  src/ingestion/history-backfill.ts          (simpler flow — no temp position writes)
M  src/eval/quote-eval.ts                     (persistResults → PG bulk; DealStore SQLite retained)
```

No new deps. No schema changes. `npm run ingest:history` CLI contract
unchanged (still takes a traces directory); `npm run backfill:history`
flags unchanged (`--from`, `--to`).

## Tier 3 — less-critical CLIs + root `.mjs` (complete)

### 8. `src/ingestion/icao-hex-ingest.ts`

**Writes now on PG:** `faa_aircraft` (updates `icao_hex` on existing rows).

**Structural change:** the old per-row `UPDATE ... WHERE tail_number = ?` loop
was replaced with a bulk `UPDATE ... FROM (VALUES …)` round-trip per batch of
1,000 tails. Round-trip count drops from ~60,000 to ~60 for a typical OpenSky
CSV. Mirrors the old `IS NULL OR != ?` guard in the WHERE clause so we only
touch rows whose `icao_hex` actually needs updating.

**Surprise:** none.

---

### 9. `src/ingestion/parquet-ingest.ts`

**Writes now on PG:** `adsb_completed_legs` (plain bulk INSERT, `id` is
SERIAL), `faa_aircraft` (bulk upsert with COALESCE preservation).

**Dedup semantic preserved.** The old per-row `SELECT ... WHERE tail_number=?
AND departure_time BETWEEN datetime(?, '-10 minutes') ...` check did one
round-trip per row. Replaced with a **per-batch pre-fetch**: for each 10K-row
batch, `SELECT tail_number, departure_time FROM adsb_completed_legs WHERE
tail_number IN (…)` once, build a minute-bucket Set, filter in-memory. Same
±10-min fuzzy match, O(batch-size) instead of O(N).

**Surprise:** none.

---

### 10. `src/ingestion/faa-operators-full.ts`

**Writes now on PG:** `faa_operators` (bulk upsert with custom update
clause using `LENGTH(EXCLUDED.name) > LENGTH(faa_operators.name)` logic),
`adsb_aircraft_state` (per-operator UPDATE with `= ANY($1::text[])`).

**Replaced SQLite idioms:**
- `WHERE tail_number IN (SELECT value FROM json_each(?))` → `WHERE tail_number = ANY(?)`
- `datetime('now', '-12 months')` → JS-computed ISO string passed as a param
- `UPDATE … WHERE … IN (SELECT … FROM … WHERE correlated)` correlated
  subquery → PG-native `UPDATE … FROM …` join (cleaner, same result)

**Perf win:** the old per-operator trip-count query ran inside the upsert
loop (~1,000 round-trips). New version pre-fetches all tail → count pairs
in one `SELECT … GROUP BY tail_number`, then aggregates per-operator in
memory. One query instead of a thousand.

**Surprise:** the `LENGTH()` comparison for preferring longer operator names
on conflict works identically in PG and SQLite. No change needed.

---

### 11. `src/ingestion/faa-full-ingest.ts`

**Writes now on PG:** `faa_deregistered` (plain bulk INSERT after TRUNCATE),
`faa_aircraft_types` (bulk upsert on `model_code`), `faa_engine_types` (bulk
upsert on `engine_code`). Also shells out to `faa-daily-diff.ts` (Tier 1,
already migrated) for MASTER.txt and to `faa-docindex-ingest.ts` (outside
Tier 3 scope — see findings below).

**Structural change:** the old `db.transaction` + array-of-closures pattern
per batch replaced with accumulator arrays + serial-awaited `bulkUpsert`
calls. Flushes happen per 500-row chunk via a queued-closure list; each
chunk is executed in order to cap concurrent PG write pressure.

**Surprise:** none. The `INSERT OR REPLACE` in the old ACFTREF/ENGINE inserts
translated cleanly to `ON CONFLICT (…) DO UPDATE` because both tables have
well-defined primary keys.

---

### 12. `src/ingestion/opensky-worker.ts`

**Writes now on PG:** `adsb_positions` (bulk INSERT), `adsb_aircraft_state`
(bulk UPSERT with the same custom `updateClause` pattern used by the D1
rewrite of `adsblol-live-worker.ts`).

**Same D1 pattern applied:**
- Startup requires `DATABASE_TYPE=postgres`, throws otherwise.
- In-memory airports index + FAA enrichment cache (hourly refresh).
- `findNearestInMemory()` replaces the old per-row SQL lookup.
- TTL extended to 48 h to match Phase 2's hot tier.
- Graceful shutdown via SIGINT/SIGTERM, closes PG pool.

**Still called:** the Express server (`src/server/index.ts:101`) auto-starts
it unless `ENABLE_OPENSKY=false`. No deletion warranted. Its role in the
architecture is "fallback feed if adsblol is down" — PM2 runs adsblol as
the primary `feed` process; opensky only kicks in when the server explicitly
enables it.

**Surprise:** none — this file is the opensky analog of the D1 rewrite, so
the pattern was well-trodden.

---

### 13. `src/ingestion/classify-aircraft.ts` (was `classify-aircraft.mjs`)

**Converted `.mjs` → `.ts`.** Moved from repo root to `src/ingestion/`.
Pipeline.ts step 2 updated: `node classify-aircraft.mjs` →
`npx tsx src/ingestion/classify-aircraft.ts`. Old `.mjs` deleted.

**Writes now on PG:** `faa_aircraft.aircraft_class` via pattern-based UPDATEs.
Each rule is a single `UPDATE … SET aircraft_class = ? WHERE aircraft_class
IS NULL AND common_name LIKE ?`. ~80 rules × one round-trip each = ~2–3 s
total — well inside cron budget.

**Behavior preserved:** same 80 rules, same order dependency (later rules
only hit unmatched rows).

**Surprise:** `datetime('now')` in the UPDATE SET replaced with `NOW()`
(TIMESTAMPTZ for `updated_at`). No other SQLite-isms.

---

### 14. `src/ingestion/update-graph.ts` (was `update-graph.mjs`)

**Converted `.mjs` → `.ts`.** Moved from repo root to `src/ingestion/`.
Pipeline.ts step 3 updated: `node update-graph.mjs` →
`npx tsx src/ingestion/update-graph.ts`. Old `.mjs` deleted.

**Writes now on PG:** `knowledge_graph` (full rebuild — DELETE + INSERT
from FAA ∩ ADS-B state), `fleet_stats` (per-class aggregate).

**Schema additions.** The old `.mjs` created `knowledge_graph` with extra
flags (`is_charter_class`, `is_near_network_airport`, `is_ghost_candidate`,
`ghost_airport`, `total_legs`, `legs_last_30d`, `updated_at`) and the
`fleet_stats` table via `CREATE TABLE IF NOT EXISTS` statements. Neither
set of columns nor `fleet_stats` existed in `schema-pg.sql`. This migration
adds both to `schema-pg.sql` and keeps an idempotent `CREATE TABLE IF NOT
EXISTS` + `ALTER TABLE IF NOT EXISTS` safety net at runtime.

**Replaced SQLite idioms:**
- `SELECT ... GROUP BY f.icao_hex` with a plain join → PG `SELECT DISTINCT ON
  (f.icao_hex)` (the SQLite version was relying on non-standard GROUP BY
  behavior that PG doesn't support).
- `UPDATE … SET total_legs = (SELECT COUNT(*) FROM adsb_completed_legs …)`
  correlated subquery → PG-native `UPDATE … FROM (SELECT … GROUP BY …) sub`.
- `datetime('now', '-30 days')` → JS-computed ISO string passed as a param.
- `db.transaction(() => …)` wrappers → plain await (PG auto-commits).

**Fuzzy-match safety propagation:** the old per-operator `UPDATE … WHERE
operator_name LIKE '%pattern%'` loop still runs per-rated-operator (~50
iterations, ~50 round-trips). Acceptable for a nightly cron.

**Surprise:** the missing `fleet_stats` table in `schema-pg.sql` was the
first evidence that the earlier migration didn't include what `update-graph.mjs`
created on-the-fly. The `.mjs` was previously running against SQLite only,
so the Postgres side was never populated with these flag columns or the
`fleet_stats` table. This migration closes that gap.

---

## Step 4: remaining `better-sqlite3` imports (audit)

Run after all Tier 3 files migrated:

```
=== better-sqlite3 imports in src/ingestion + src/analytics + src/eval ===
src/ingestion/ntsb-ingest.ts         (was NOT in any tier — see findings below)
src/analytics/data-quality.ts        (was NOT in any tier — see findings below)
src/analytics/safety-enhanced.ts     (was NOT in any tier — see findings below)
```

And in `src/memory/`, unchanged and allowed per task rules:
```
src/memory/migrations.ts        (SQLite migration runner, stays)
src/memory/database.ts          (the bridge itself)
src/memory/pg-database.ts       (the PG bridge, imports pg not better-sqlite3)
src/memory/knowledge-graph.ts   (read helper — allowed per task rules)
src/memory/migrate-data.ts      (one-time SQLite→PG migration utility, stays)
src/memory/autonomy-store.ts, webhook-dedup.ts, deal-store.ts,
src/memory/deal-event-log.ts, message-store.ts, call-store.ts,
src/memory/composite-stores.ts  (still SQLite-backed; retirement is Phase 9)
src/monitoring/health-queries.ts
```

## Files outside Tier 3 that still write SQLite — flagged for later

These did not appear in the Tier 1/2/3 file lists but still bind to
`better-sqlite3` or `getDb()` and write to SQLite tables. Recommend
addressing in a follow-up phase (Tier 4 or Phase 9 retirement):

- `src/ingestion/ntsb-ingest.ts` — writes `ntsb_accidents`. Table has 0 rows
  in both SQLite and PG per the earlier audit. Likely never run successfully.
- `src/ingestion/airmen-ingest.ts` — writes `pilot_contacts`, `pilot_aircraft_link`.
  Audit showed these are equal rows in both tiers (migration frozen). If this
  runs again, SQLite would diverge.
- `src/ingestion/faa-docindex-ingest.ts` — writes `faa_docindex`. Equal rows
  across tiers. Shelled out to by `faa-full-ingest.ts`, so will need a
  matching migration once we run a full FAA reload.
- `src/ingestion/faa-ingest.ts`, `listing-tracker.ts`, `target-companies.ts`
  — seed/scrape scripts, rarely run.
- `src/analytics/data-quality.ts` — writes `data_quality_runs`. 0 rows in
  both tiers — script has never run to completion.
- `src/analytics/safety-enhanced.ts` — purpose unclear; needs audit.

**Server + MCP hot paths still use `getDb()`** (flagged in the pre-Phase-6
architecture review as "20 hot-path violations"):
- `src/server/chat-context.ts`, `src/server/routes/{intelligence,radar,deals}.ts`
- `src/mcp/tools.ts`
- `src/monitoring/health-check.ts`

Tier 3 as specified didn't include these. The phase goal was "migrate the
remaining SQLite-primary **writers**." Reads from SQLite in serving code
are a separate concern — they don't prevent SQLite retirement so long as
Phase 9 deletes the `getDb()` API and forces a compile-time migration. Not
urgent; flagged for visibility.

---

## Verification (Tier 3)

```
npm run typecheck   → clean
npm test            → 649 passed (21 files, 3 skipped). No regressions.
```

No scripts invoked against real PG. All Tier 3 scripts are CLI-only and
would make large writes; per task, held until Lightsail deploy.

## Files changed in Tier 3

```
M  src/ingestion/icao-hex-ingest.ts           (bulk UPDATE via VALUES-join)
M  src/ingestion/parquet-ingest.ts            (bulk INSERT + per-batch dedup)
M  src/ingestion/faa-operators-full.ts        (bulk upsert + pre-fetched counts)
M  src/ingestion/faa-full-ingest.ts           (bulk INSERT/UPSERT for 3 tables)
M  src/ingestion/opensky-worker.ts            (D1-pattern PG rewrite)
M  src/ingestion/pipeline.ts                  (step 2/3 commands → npx tsx *.ts)
M  src/memory/schema-pg.sql                   (added kg flag cols + fleet_stats)
NEW src/ingestion/classify-aircraft.ts        (converted from .mjs)
NEW src/ingestion/update-graph.ts             (converted from .mjs)
D  classify-aircraft.mjs                      (deleted, replaced by .ts)
D  update-graph.mjs                           (deleted, replaced by .ts)
```

## Phase 6 summary

After Tier 3, **no writer listed in the Tier 1/2/3 scope targets SQLite.**
SQLite retention is limited to:

- `src/memory/*` stores (read/write helpers consumed by server + orchestrator).
  These are pending Phase 9 retirement.
- The seven flagged scripts above (ntsb-ingest, airmen-ingest, etc.) — not
  in any Tier 3 scope, flagged for Tier 4 or direct retirement.
- `DealStore(eval-deals.db)` in quote-eval — intentional sandbox, not
  production data.

Phase 6 goal — "SQLite has no live writers in the migrated critical path"
— is met. Full retirement (Phase 9) needs to address the `src/memory/*`
stores + the seven flagged scripts. No blockers to deploy Tier 1–3 migrations
to Lightsail.
