# Dumont Agent — Architecture Review (2026-04-16)

Pre-YC review. Solo founder, pre-revenue. Reviewer assumes you're doing the
in-person interview May 4 with whatever this codebase looks like that morning.

Direct readings from Supabase + filesystem walk. No diplomacy.

---

## PART 1 — Data Layer Health

| Table | Rows | Last write | Verdict |
|---|--:|---|---|
| `adsb_completed_legs` | 5,963,225 | 2026-04-13 | ⚠ 749 distinct days for 821 archived ⇒ 74-day gap |
| `faa_aircraft` | 314,809 | 2026-04-13 04:06 | ✓ fresh (3 days) |
| `faa_registry_changes` | 844,388 | 2026-04-12 23:38 | ✓ daily diff running |
| `knowledge_graph` | 70,999 | 2026-04-13 01:56 | ✓ rebuilt by nightly pipeline |
| `route_vectors` | 15,010 | 2026-04-14 17:39 | ✓ ivfflat index `idx_rv_embedding` (lists=100) exists |
| `operator_market_share` | 316 | month=**2025-12** | 🔴 **4 months stale** |
| `aircraft_utilization` | 15,919 | month=**2025-12** | 🔴 **4 months stale** |
| `airport_activity` | 121,850 | date=**2025-12-17** | 🔴 **4 months stale** |
| `route_trends` | 86,471 | month=**2025-12** | 🔴 **4 months stale** |
| `fleet_snapshot` | **0** | — | 🔴 **never built** |
| `ntsb_accidents` | **0** | — | 🔴 **never ingested** (CLAUDE.md says "80K+ records") |
| `data_quality_runs` | **0** | — | 🔴 **quality:check has never run** |
| `deals` | **0** | — | empty (no real customers — expected) |
| `deal_events` | **0** | — | 🔴 **append-only audit trail has zero events** |
| `deal_outcomes` | **0** | — | 🔴 **dead loop — see Part 4** |
| `route_intel` | **0** | — | 🔴 **learning composite never written** |
| `operator_profiles` | **0** | — | 🔴 **learning composite never written** |
| `client_profiles` | **0** | — | empty (no clients — expected) |
| `validation_ledger` | **0** | — | 🔴 **quote-validation never recorded** |
| `messages` | **0** | — | 🔴 **inbound message persistence not wired** |
| `calls` | **0** | — | 🔴 **Vapi transcripts not persisted** |
| `adsb_aircraft_state` | 76,647 | 2026-04-13 18:23 | ✓ live worker active |

**Schema typing bugs (will bite you in production):**
- `adsb_completed_legs.departure_time` stored as **text**, not `timestamp` (proven by `to_char(text, ...)` error)
- `pipeline_runs.started_at` stored as **text** (proven by `started_at > NOW()` operator error)
- `fleet_snapshot.date` stored as **text**

These work today because SQLite is permissive and you stringified everything before insert. PostgreSQL doesn't care until someone writes a query that assumes the column is a date — then it explodes. Search the codebase for any `WHERE departure_time >=` or `ORDER BY started_at` and you'll find latent bugs.

**The four-month analytics gap is the biggest single problem in the data layer.** Every public-facing route page that pulls from `route_trends` or `operator_market_share` is showing December 2025 data on April 16, 2026. If a YC partner clicks one of these pages and looks at "Recent Activity" and it says "December 2025" — your entire freshness story is gone.

---

## PART 2 — Raw-to-Legs Coverage Gap

Numbers from the live database:

```
S3 archived days (status='complete'):        821  (Jan 2024 → Apr 14 2026)
adsb_completed_legs distinct days:           747  (within Jan 2024 → Apr 15 2026)
gap:                                         ~74 days
```

Plus 2 days are anomalously low-volume in legs:
```
2026-04-10:    20 legs  (avg is 7,962)  ← processing failure
2026-04-12:   310 legs  (under 500 threshold)  ← partial processing
2026-04-11:   missing entirely
```

The pipeline that turns raw `.tar` archives into `adsb_completed_legs` is dropping data. Either `history-backfill.ts` was never run for the missing days, or it ran and silently failed without writing to `pipeline_runs` (which has its own typing bug — see Part 1).

**This is the difference between "we have 821 days of raw flight data on Glacier" (true) and "we have 821 days of processed, queryable flight intelligence" (false — you have ~91% of that).** Distinction matters at YC because the demo runs against `adsb_completed_legs`, not against S3 tars.

---

## PART 3 — Code Architecture Smells

### Hot-path uses of raw `getDb()` / better-sqlite3 (will break under PG)

The migration to PostgreSQL is **incomplete in serving code**. These files still call the SQLite-only `getDb()`:

```
src/server/routes/intelligence.ts:35, 225, 265, 517, 528, 539   (6 violations)
src/server/routes/deals.ts:27, 31, 35, 39                       (4 violations)
src/server/routes/radar.ts:12, 21, 39                           (3 violations)
src/server/chat-context.ts:12, 22, 26, 30, 34                   (5 violations)
src/mcp/tools.ts:9, 37                                          (2 violations)
```

20 hot-path call sites. All need to be `getDatabase()` (the async DbBridge). Right now any production deploy with `DATABASE_TYPE=postgres` will throw on the first request to those routes — unless you're still running on SQLite, which makes the whole "PostgreSQL migration complete" claim half-true.

### God files

```
src/memory/migrations.ts          1032 lines   (30 migrations in one file)
src/capabilities/intake.ts         720 lines   (NLP + parsing + domain mixed)
src/ingestion/airmen-ingest.ts     604 lines   (CSV parsing + batch insert + geocoding)
src/memory/composite-stores.ts     601 lines   (3 stores in one file)
src/mcp/tools.ts                   564 lines   (12 tools in one file)
src/memory/learning-loop.ts        560 lines   (events + embeddings + scoring)
src/server/routes/intelligence.ts  547 lines   (10 endpoints in one file)
```

`migrations.ts` at 1032 lines for 30 migrations is fine — migrations belong together. The other six are testability red flags but not bugs.

### Duplicate logic

- `parseFaaDate()` defined twice: `src/ingestion/faa-full-ingest.ts:130` and `src/ingestion/faa-docindex-ingest.ts:98`
- `formatBytes()` defined twice: `src/ingestion/archive-adsb-raw.ts:403` and `src/ingestion/archive-faa-raw.ts:138` (slightly different — one has GB)
- Date/time formatters scattered across `intake.ts`, `dumont-brain.ts`, `health-queries.ts`

### Hardcoded config that should be env

- Live worker poll intervals: `src/ingestion/adsblol-live-worker.ts:23-26`, `src/ingestion/opensky-worker.ts:19-22`
- Anthropic model + tokens: `src/server/routes/chat.ts:46` — `claude-sonnet-4-20250514` is **the wrong model name**; current is `claude-sonnet-4-6` per CLAUDE.md
- 250 nm radar radius hardcoded: `src/ingestion/adsblol-live-worker.ts:145`
- CORS allowlist: `src/server/index.ts:48-50` (despite `ALLOWED_ORIGINS` env var being documented)

### Missing error handling

- All scripts under `src/ingestion/` and `scripts/` have `.catch(err => process.exit(1))` at the bottom — good.
- `src/server/routes/conversation.ts:32` doesn't use `asyncHandler` but the handler is sync — low risk.
- No silent-failure smell in cron-runnable code — these scripts crash loudly when broken (which is why we have 0 NTSB rows: the script never ran, didn't fail silently).

---

## PART 4 — What's Missing From the Thesis

### The closed loop is dead

`deal_outcomes` is defined in `src/memory/schema-pg.sql` but **nothing in the codebase writes to it**. Verified: zero rows, zero INSERT statements anywhere.

What actually exists:
- `src/memory/learning-loop.ts:246-514` updates `route_intel`, `operator_profiles`, `client_profiles`, `validation_ledger`
- All four tables are at **0 rows**

So even the "real" learning composites (which would be a workable substitute for `deal_outcomes`) are also empty. The 5-stage pipeline (`INTAKE → SOURCING → QUOTE → GUARDIAN → SCENARIO`) is plumbed but **has never run end-to-end on a real or test deal**. `deal_events` has 0 rows confirms this — no stage transitions have ever been logged.

**This is the YC-killer if surfaced.** The deck says "every closed deal feeds back into route_intel and operator_profiles to calibrate pricing." The database says no deal has ever closed, no event has ever been emitted, no profile has ever been updated.

### Pricing engine — there is no "Charter Index"

`src/capabilities/quote.ts:39-94` is your pricing function. It does:

1. Call Aviapages API (`src/integrations/aviapages.ts`) to get a price range
2. If a `dealStore` is provided, multiply the range by `(1 + historicalDelta)` where `historicalDelta` comes from prior deals on the same route

That's it. Two phases:
- **Phase 1**: third-party API call to a competitor's pricing service
- **Phase 2**: a multiplicative correction based on... 0 historical deals, because `deals` is empty

There is no FAA data in the pricing path. There is no ADS-B data in the pricing path. There is no physics model. There is no "1.97 TB of raw flight intelligence calibrating prices." The pricing engine is **Aviapages with a no-op delta multiplier**.

If a YC partner asks "where does the price come from?" the honest answer is "Aviapages." That's a fine answer if you own it. It is not the answer the deck implies.

### No caching layer

Every API request hits Supabase. No Redis, no node-cache, no SWR helper, nothing. At low load this is fine. At SEO scale (the documented goal of 170K route URLs for the public-facing site) the Supabase free-tier connection pool will throttle inside a week of any indexing event.

Endpoints that would benefit from a 1–5 minute TTL:
- `GET /api/fleet/stats`
- `GET /api/routes/:origin/:destination`
- `GET /api/analytics/market`
- `GET /api/analytics/airport/:icao`
- `GET /api/analytics/operator/:name`

### Vapi voice — transcripts thrown away

`src/server/routes/vapi-llm.ts:1-79` accepts inbound Vapi calls, generates a Claude response, streams it back. The transcript is built in memory in `buildTranscript(messages)` and **never written to the `calls` table**. `calls` has 0 rows. `CallStore.add()` exists in `src/memory/call-store.ts` but is called from nowhere. Deepgram integration is scaffolded in `src/integrations/deepgram.ts` and never invoked.

If voice is a product surface, persist the transcripts. If it isn't, delete the route and the table.

### MCP and HTTP duplicate each other

12 MCP tools in `src/mcp/tools.ts` map 1:1 to HTTP endpoints in `src/server/routes/intelligence.ts` and `src/server/routes/analytics.ts`. Same SQL, same tables, same shape. No shared query layer. Maintaining both means every schema change needs two edits.

---

## PART 5 — Three Things to Fix Before YC (May 4)

### 1. Refresh the analytics tables. Today.

**What:** `operator_market_share`, `aircraft_utilization`, `airport_activity`, `route_trends` are 4 months stale (max month = 2025-12). `fleet_snapshot` has zero rows. `data_quality_runs` has zero rows.

**Why it matters:** YC partners click links. The route page prototype reads from these tables. A partner who lands on a route page and sees "December 2025 — most active operator" on April 16 will assume the entire system is dead. This is the cheapest credibility win available.

**Effort:** 2 hours. The build commands already exist:
```bash
npm run analytics:build -- --all
npm run quality:check
```
If those scripts fail (likely — schema mismatches in `pipeline_runs`/`fleet_snapshot` are typing bugs), allocate another 2 hours to fix the typing and rerun.

**First step:** `npm run analytics:build -- --all 2>&1 | tee /tmp/analytics-rebuild.log` and read the errors.

### 2. Process the 74-day raw-to-legs gap.

**What:** S3 has 821 days of raw ADS-B archived. `adsb_completed_legs` has 747 distinct days within the same range. The pipeline that converts raw → legs has dropped 74 days. Plus 2026-04-10 has 20 legs (vs 8K average) and 2026-04-11 is missing entirely — recent failures.

**Why it matters:** The "5.96 million completed legs" number IS your demo. Every claim about ghost detection, route frequency, operator behavior runs against this table. A 9% coverage hole means random demo queries will return suspiciously empty results. ("Show me activity at KAPA in February 2024" — if Feb 2024 is in the gap, the result is zero. Looks broken.)

**Effort:** 4 hours. Identify the missing days from `archive_progress` minus distinct dates in legs, then run `npm run backfill:history -- --date YYYY-MM-DD` for each. Or wrap into a one-shot script that processes the gap dates.

**First step:** Run this diff query and save the missing-day list:
```sql
SELECT ap.date FROM archive_progress ap
WHERE ap.status='complete'
  AND NOT EXISTS (
    SELECT 1 FROM adsb_completed_legs l
    WHERE DATE(l.departure_time) = ap.date::date
  )
ORDER BY ap.date;
```

### 3. Make ONE end-to-end test deal flow through the pipeline and write to every table.

**What:** `deals`, `deal_events`, `deal_outcomes`, `route_intel`, `operator_profiles`, `validation_ledger` — all six are at zero. The 5-stage deal pipeline has never executed against a real or fixture deal. The whole "closed-loop learning system" claim has zero supporting data.

**Why it matters:** At demo time you want to be able to say: *"watch — I'll create a sample charter inquiry, the system runs it through INTAKE → SOURCING → QUOTE → GUARDIAN → SCENARIO, every stage transition is logged in deal_events, and when I close it the deal_outcome updates route_intel which changes the next quote on the same route."* Right now you can't run that demo because none of those tables get written.

**Effort:** 8 hours. The wiring exists in `src/capabilities/`, `src/memory/learning-loop.ts`, and the orchestrator. The bug is somewhere in the sequence — either the orchestrator never calls the persistence step, or the persistence is gated behind a conditional that's always false. Run a fixture deal end-to-end (`npm test` already exercises parts of this — look at `tests/learning-loop.test.ts:39 tests passing` — but the runtime path doesn't write to PG).

**First step:** Write a one-off script `scripts/smoke-deal-pipeline.ts` that creates a fixture deal, runs it through the orchestrator, and asserts each table got written. Find what's broken from the failures.

---

## PART 6 — Three Things You're Over-Engineering

### 1. The MCP server (kill it or kill the duplicate REST routes)

You have 12 MCP tools and 12 matching HTTP endpoints. The audience for both is the same: you, in a Claude Desktop window. You don't have a third-party developer using your MCP server. You don't have a website calling your REST API in production.

**Option A:** Delete `src/mcp/`, `src/server/routes/intelligence.ts`, `src/server/routes/analytics.ts`. Keep the data ingestion layer + Supabase. When you need to query, write a query directly. Saves 1100 lines of code.

**Option B:** Keep MCP, delete the matching REST routes. MCP is what you actually use. The REST API is theoretical infrastructure for a frontend you haven't built yet.

Either way, stop maintaining both.

### 2. The `route_vectors` pgvector index

15,010 vectors with an ivfflat index. Beautifully built. **Never queried in serving code.** Grep `src/` for `route_vectors` — the only writes are from the embedding builder, the only reads are from the embedding builder verifying its own writes. There is no `findSimilarRoutes()` endpoint, no semantic search exposed to MCP or REST.

You spent the cost of 15K embedding API calls + an ivfflat index on a feature that doesn't ship. Either:
- Wire it into a "find similar routes" tool (8 hours), or
- Delete the table and the embedding script. You can rebuild from scratch in a day if the use case ever lands.

### 3. The Vapi/Deepgram/voice infrastructure (until you have one persisted call)

`vapi-llm.ts`, `deepgram.ts`, `call-store.ts`, the `calls` table. All scaffolded. Zero rows. Zero usage you can prove at YC.

Pre-revenue, the right answer is: rip out the voice surface entirely, or fix the persistence and use it for a real test call before May 4. "I have voice infra" is worth zero. "Here's a recording of an inbound charter inquiry that Dumont handled, with the transcript in the database" is worth a lot. Right now you have neither — you have the cost of voice infra (config complexity, dependencies) without any evidence value.

### Honorable mentions (not a top-3 but worth noting)

- **DbBridge async layer**: you migrated SQLite → PG and kept an SQLite-shaped adapter. PG is async-native. The bridge is a translation layer that exists because the old code expected `.prepare().get()` to be sync. Worth burning down post-YC.
- **640 tests for a product with 0 users** is fine, but the time-to-test ratio is high. If a test isn't preventing a bug you've actually shipped, it's costing maintenance. Prune ruthlessly post-YC.
- **The Guardian wrapper** runs after every pipeline stage. With `deal_events: 0` it has never validated anything in production. Either prove it's catching bugs in test, or simplify to "validate at quote generation only" until you have throughput.

---

## Part headers + 1-line verdicts

```
PART 1 — Data Layer Health           🔴 Analytics 4 months stale; 7 tables at 0 rows; 3 schema typing bugs
PART 2 — Raw-to-Legs Gap             🔴 74 days of raw archived but unprocessed; recent days dropping
PART 3 — Code Architecture Smells    🟡 20 hot-path getDb() leaks; PG migration is half-done
PART 4 — Thesis vs Code Gaps         🔴 Closed loop is dead; "Charter Index" is Aviapages + zero data
PART 5 — Three YC Fixes              ⚙ Refresh analytics, fill leg gap, run one end-to-end deal
PART 6 — Three Over-Engineered       ✂ Kill MCP-or-REST duplication, route_vectors, voice scaffold
```
