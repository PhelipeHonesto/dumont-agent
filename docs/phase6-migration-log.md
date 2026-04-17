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

## Next: Tier 3 (not starting until approved)

Per the tier plan:
- `src/ingestion/faa-full-ingest.ts`
- `src/ingestion/faa-operators-full.ts`
- `src/ingestion/icao-hex-ingest.ts`
- `src/ingestion/parquet-ingest.ts`
- `src/ingestion/opensky-worker.ts` (audit whether still called)
- `classify-aircraft.mjs` (root, rewrite as .ts)
- `update-graph.mjs` (root, rewrite as .ts)
