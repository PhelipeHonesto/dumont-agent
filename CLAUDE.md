# Dumont Agent — OSA Aviation Intelligence + Charter Brokerage Engine

AI-powered charter brokerage engine and aviation intelligence platform for Orange Sunshine Aviation (OSA). Single orchestrator with callable capabilities — not independent agents. Ingests FAA registry, ADS-B flight data, lien records, pilot records, and market listings into SQLite. Exposes intelligence via REST API, MCP server, and React dashboard. Brokers charter deals through an automated pipeline: intake, guardian validation, pricing, operator sourcing, client presentation, and learning loop.

## Architecture

- **Database**: SQLite at `data/dumont.db`, 25 migrations, WAL mode, `busy_timeout = 30000`
- **Express server**: port 3001, `src/server/index.ts` — REST API + Vapi voice webhook
- **MCP server**: stdio transport, `src/mcp/server.ts` — 9 tools for Claude Desktop
- **Dashboard**: Vite + React at `dashboard/`, port 5174, PWA-enabled
- **Live ADS-B worker**: `src/ingestion/adsblol-live-worker.ts` — streams from adsb.lol
- **Nightly pipeline**: `src/ingestion/pipeline.ts` — FAA diff + classify + rebuild graph
- **Eval harness**: `src/eval/quote-eval.ts` — 20 scenarios, scores accuracy within +/-20%
- **Health monitoring**: `src/monitoring/health-queries.ts` — traffic light (green/yellow/red)

## Database Tables (25 migrations)

| # | Table | Purpose |
|---|-------|---------|
| 1 | `_migrations` | Migration tracking (id, name, applied_at) |
| 2 | `deals` | Deal records — route, pricing (cents), operator, client, outcome, timing |
| 3 | `route_intel` | Route intelligence — avg price, demand trend, seasonal factors. PK: (route, aircraft_class) |
| 4 | `operator_profiles` | Operator performance — reliability, response time, pricing delta, cancel rate |
| 5 | `client_profiles` | Client history — spend, frequency, preferred routes/aircraft |
| 6 | `validation_ledger` | Quote validation — estimate vs actual, margin, outcome tracking |
| 7 | `deal_events` | Append-only audit trail — stage transitions, payloads, timestamps |
| 8 | `messages` | Inbound/outbound messages — all channels, threading, intent, confidence |
| 9 | `calls` | Voice call sessions — participants, transcript, detected entities |
| 10 | `autonomy_rules` | Auto-send thresholds per channel/intent/recipient |
| 11 | `processed_webhooks` | Idempotency keys for webhook dedup |
| 12 | *(alter)* | Expands validation_ledger with ghost value, payment status, operator details |
| 13 | `faa_aircraft` | FAA registry — tail number, manufacturer, model, class, owner, operator, icao_hex |
| 13 | `faa_operators` | Part 135 operators — certificate, fleet size, location, safety ratings |
| 13 | `faa_airports` | Airports — ICAO/IATA, coordinates, runway, fuel, tower |
| 14 | `adsb_positions` | Raw ADS-B position reports — lat/lon, altitude, speed, timestamp |
| 14 | `adsb_aircraft_state` | Current aircraft state — airborne/idle, nearest airport, idle hours |
| 15 | `adsb_completed_legs` | Materialized flight legs — origin, destination, time, distance, class |
| 16 | `deal_outcomes` | Structured deal outcomes for learning loop — price error, confidence, reason lost |
| 17 | `faa_registry_changes` | Daily diff — new, deregistered, ownership change, field change |
| 18 | `pipeline_runs` | Pipeline execution log — steps, stats, ghost count, charter tracked |
| 19 | `faa_docindex` | FAA document index — liens, security agreements, bills of sale |
| 20 | `pilot_contacts` | Airmen records — certificate, ratings, medical, location |
| 20 | `pilot_aircraft_link` | Pilot-to-aircraft proximity links — heuristic, not authoritative |
| 21 | `aircraft_listings` | For-sale listings from AvBuyer/Controller/Trade-A-Plane — price history, days on market |
| 22 | `target_companies` | Prospecting targets — company, fleet, estimated annual trips |
| 22 | `target_contacts` | Contacts at target companies |
| 23 | `eval_runs` | Per-scenario eval results — estimate vs market range, pass/fail |
| 23 | `eval_run_summaries` | Aggregate eval stats — accuracy %, mean/median error |
| 24 | `backfill_progress` | Historical ADS-B backfill tracking by date |
| 25 | `knowledge_graph` | Joined FAA + ADS-B view with safety scores |

## npm Scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `test` | `vitest run` | Run 628 tests across 19 files |
| `typecheck` | `tsc --noEmit` | TypeScript strict mode check |
| `sim` | `tsx src/run-sim.ts` | Run 25 deal simulation scenarios |
| `deal` | `tsx src/run-deal.ts` | Run a single deal interactively |
| `server` | `npx tsx src/server/index.ts` | Start Express API on port 3001 |
| `mcp:serve` | `tsx src/mcp/server.ts` | Start MCP server (stdio) |
| `dashboard` | `cd dashboard && npx vite --open` | Start React dashboard on port 5174 |
| `pipeline` | `tsx src/ingestion/pipeline.ts` | Full nightly pipeline (diff + classify + graph) |
| `ingest:faa` | `tsx src/ingestion/faa-ingest.ts` | Import FAA MASTER registry file |
| `faa:diff` | `tsx src/ingestion/faa-daily-diff.ts` | Detect registry changes since last import |
| `ingest:icao` | `tsx src/ingestion/icao-hex-ingest.ts` | Map ICAO hex codes to tail numbers |
| `ingest:docindex` | `tsx src/ingestion/faa-docindex-ingest.ts` | Import FAA document index (liens, bills of sale) |
| `ingest:airmen` | `tsx src/ingestion/airmen-ingest.ts` | Import airmen records + link pilots to aircraft |
| `ingest:operators` | `tsx src/ingestion/faa-operators-full.ts` | Import full Part 135 operator database |
| `ingest:safety` | `tsx src/ingestion/safety-ratings.ts` | ARGUS/Wyvern/BAO safety ratings |
| `ingest:listings` | `tsx src/ingestion/listing-tracker.ts` | Scrape aircraft-for-sale listings |
| `ingest:history` | `tsx src/ingestion/adsblol-ingest.ts` | Historical ADS-B data from adsb.lol |
| `ingest:parquet` | `tsx src/ingestion/parquet-ingest.ts` | Import ADS-B from parquet files |
| `backfill:history` | `tsx src/ingestion/history-backfill.ts` | Backfill ADS-B legs day by day |
| `adsb:live` | `tsx src/ingestion/adsblol-live-worker.ts` | Live ADS-B position streaming |
| `opensky` | `tsx src/ingestion/opensky-worker.ts` | OpenSky Network position polling |
| `export:targets` | `tsx src/ingestion/target-companies.ts` | Export prospecting target list |
| `eval:quote` | `tsx src/eval/quote-eval.ts` | Run quote accuracy evaluation (20 scenarios) |
| `health:check` | `tsx src/monitoring/health-check.ts` | Standalone data freshness check |

## API Endpoints

### Intelligence API (no auth, `src/server/routes/intelligence.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/aircraft/:tailNumber` | Full aircraft profile — registration, owner, ADS-B state, flight stats, liens, pilots, ghost status |
| GET | `/api/aircraft/:tailNumber/flights` | Flight history — completed legs with origin, destination, times, distances |
| GET | `/api/airport/:icao/ghosts` | Ghost candidates near airport — idle charter aircraft away from base |
| GET | `/api/fleet/stats` | Fleet summary — tracked, airborne, idle, ghost count, class breakdown |
| GET | `/api/routes/:origin/:destination` | Route analytics — frequency, avg time, class mix, busiest days, monthly trend |
| GET | `/api/market/listings` | Active for-sale listings — price, type, days on market |
| GET | `/api/market/transactions` | Recent FAA ownership changes |
| GET | `/api/health/data` | Data freshness traffic light across all sources |
| GET | `/api/health/feed` | ADS-B feed liveness (alive/stale/dead) |

### Other Routes (auth required)

| Method | Path | File | Purpose |
|--------|------|------|---------|
| POST | `/chat/completions` | `routes/vapi-llm.ts` | Vapi voice AI webhook |
| POST | `/api/dumont/respond` | `routes/conversation.ts` | REST conversation endpoint |
| POST | `/api/chat` | `routes/chat.ts` | Dumont AI co-pilot SSE streaming |
| GET | `/api/deals`, `/api/deals/:id` | `routes/deals.ts` | Deal management |
| POST | `/api/deals/:id/review` | `routes/deals.ts` | Deal review/approval |
| GET | `/api/radar/stats`, `/api/radar/ghost` | `routes/radar.ts` | ADS-B fleet radar |
| GET | `/health` | `routes/health.ts` | Server health check |

## MCP Tools (`src/mcp/server.ts`)

All tools query SQLite directly (no HTTP). stdio transport. Server name: `dumont-intelligence`.

| Tool | Inputs | Returns |
|------|--------|---------|
| `lookup_aircraft` | `tail_number: string` | Registration, owner, operator, ADS-B state, flight stats, liens, pilots, ghost status |
| `get_flights` | `tail_number: string`, `limit?: number` | Completed flight legs with origin/dest, times, distances |
| `find_ghosts` | `airport_icao: string` | Ghost candidates near airport across all charter classes |
| `fleet_stats` | *(none)* | Tracked aircraft, airborne/idle counts, class breakdown, top ghost airports |
| `route_intel` | `origin: string`, `destination: string` | Flight frequency, avg time, class mix, busiest days, monthly trend |
| `active_listings` | `aircraft_type?: string`, `limit?: number` | For-sale listings with prices and days on market |
| `recent_transactions` | `limit?: number` | FAA registry ownership changes |
| `data_health` | *(none)* | Traffic-light freshness for pipeline, ADS-B, FAA, knowledge graph |
| `feed_health` | *(none)* | ADS-B feed status: alive/stale/dead, positions/hour, legs today |

## Key Files

| File | Purpose |
|------|---------|
| `src/memory/database.ts` | SQLite singleton — WAL, FK, migrations on first access. `getDb()` everywhere. |
| `src/memory/migrations.ts` | 25 migrations — all tables, indexes, ALTER additions |
| `src/memory/knowledge-graph.ts` | `KnowledgeGraphStore` — aircraft lookup, ghost candidates, fleet stats, spatial queries |
| `src/memory/deal-store.ts` | Deal CRUD — integer cents, indexed |
| `src/memory/learning-loop.ts` | DealContext → DealRecord + composite updates (transactional) |
| `src/orchestrator/index.ts` | Pipeline engine — stage advancement, closeDeal |
| `src/orchestrator/deal-context-manager.ts` | ULID-based deal IDs, create/update context |
| `src/orchestrator/stage-transitions.ts` | Stage advancement rules, awaiting_review |
| `src/orchestrator/context-factory.ts` | Stage-specific context slices for capabilities |
| `src/capabilities/intake.ts` | Parse trip request + qualify client (code-layer + LLM fallback) |
| `src/capabilities/guardian.ts` | 5 stage-specific validation passes, blocks on critical failures |
| `src/capabilities/quote.ts` | Phase 1 estimate (Aviapages API) + Phase 2 real quote + margin bounds |
| `src/capabilities/sourcing.ts` | 5-factor weighted operator ranking, one operator + one backup |
| `src/capabilities/scenario.ts` | Client presentation builder + backup activation + timer |
| `src/capabilities/respond.ts` | Response generation + evaluator-optimizer + confidence gate |
| `src/capabilities/sdr.ts` | AI sales development rep (voice + text) |
| `src/capabilities/draft-evaluator.ts` | Evaluator-optimizer pattern for outbound drafts |
| `src/server/dumont-brain.ts` | Conversational engine with session state |
| `src/server/chat-context.ts` | Builds aviation context for chat from DB |
| `src/integrations/aviapages.ts` | Aviapages Price Calculator + Flight Calculator API client |
| `src/config.ts` | Models, timeouts, margin policy, quote validity |
| `src/fixtures/sim-data.ts` | Simulation data — operators, airports, pricing |
| `update-graph.mjs` | Standalone: joins faa_aircraft + adsb_aircraft_state → knowledge_graph |
| `classify-aircraft.mjs` | Standalone: fills NULL aircraft_class via common_name pattern matching |

## Ingestion Pipeline — Order of Operations

Full data refresh sequence (run individually or via `npm run pipeline`):

1. **`ingest:faa`** — Download + import FAA MASTER registry → `faa_aircraft` (~300K rows)
2. **`ingest:icao`** — Map ICAO hex codes to tail numbers → updates `faa_aircraft.icao_hex`
3. **`faa:diff`** — Compare current vs previous registry → `faa_registry_changes`
4. **`classify-aircraft.mjs`** — Fill `aircraft_class` on unclassified aircraft via pattern matching
5. **`update-graph.mjs`** — Join FAA + ADS-B → `knowledge_graph` with ghost candidates
6. **`ingest:operators`** — Full Part 135 operator database → `faa_operators`
7. **`ingest:safety`** — ARGUS/Wyvern/BAO ratings → `faa_operators` safety columns
8. **`ingest:docindex`** — FAA document index (liens, bills of sale) → `faa_docindex`
9. **`ingest:airmen`** — Airmen records + pilot-aircraft linking → `pilot_contacts`, `pilot_aircraft_link`
10. **`ingest:listings`** — Scrape for-sale listings → `aircraft_listings`
11. **`adsb:live`** — Continuous: live ADS-B positions → `adsb_positions`, `adsb_aircraft_state`
12. **`backfill:history`** — Historical: ADS-B legs day by day → `adsb_completed_legs`

The nightly `pipeline` script runs steps 1-5 automatically, propagates safety scores, and logs to `pipeline_runs`.

## Capabilities (Dumont Deal Pipeline)

Pipeline: `INTAKE → GUARDIAN → ESTIMATE → GUARDIAN → SOURCE → GUARDIAN → QUOTE → GUARDIAN → [AWAITING_REVIEW] → PRESENT → GUARDIAN → CLOSE → LEARN`

| Capability | File | Purpose |
|------------|------|---------|
| **Intake** | `src/capabilities/intake.ts` | Parse trip request, extract route/dates/pax/budget, qualify client. Code-layer parser first, LLM fallback for ambiguous input. |
| **Guardian** | `src/capabilities/guardian.ts` | Continuous validation — runs after EVERY stage. 5 stage-specific passes. Blocks on critical failures (like EGPWS). Checks: route validity, budget alignment, operator certs, margin bounds, timing. |
| **Estimate** | `src/capabilities/quote.ts` | Phase 1: Aviapages Price Calculator API. Silent internal anchor — client never sees "Aviapages". Budget gate: reject if estimate exceeds client budget. |
| **Sourcing** | `src/capabilities/sourcing.ts` | 5-factor weighted ranking: proximity, reliability, pricing delta, response time, fleet match. Selects ONE operator + ONE backup. Never blast RFQs. |
| **Quote** | `src/capabilities/quote.ts` | Phase 2: real operator quote + OSA margin (8-10%). Margin bounds enforced. |
| **Scenario** | `src/capabilities/scenario.ts` | Build client presentation. Backup activation logic if primary operator fails. Expiration timer. |
| **Respond** | `src/capabilities/respond.ts` | Generate outbound messages. Evaluator-optimizer pattern. Confidence-gated autonomy. |
| **SDR** | `src/capabilities/sdr.ts` | AI sales development rep for outbound voice + text prospecting. |
| **Learning Loop** | `src/memory/learning-loop.ts` | Every closed deal (won or lost) updates route_intel, operator_profiles, client_profiles. Deal 50 is smarter than deal 1. |

## Code Patterns

- **All money in integer cents** — `asking_price_cents`, `osa_price_cents`, etc. Never floats for money. Every money field has companion `currency TEXT DEFAULT 'USD'`.
- **All dates as ISO strings** — SQLite `datetime('now')` for created_at/updated_at
- **Zod schemas** for all validation — `src/schemas/` is the single source of truth
- **`getDb()`** for database access — singleton in `src/memory/database.ts`, auto-migrates on first call
- **`busy_timeout = 30000`** — 30s wait for concurrent write locks
- **`schema_version`** on every table — forward-compatible evolution
- **ULID for deal IDs** — globally unique, sortable, no collisions
- **`deal_events` is append-only** — no UPDATE, no DELETE. Audit trail.
- **Express 5** with `asyncHandler` wrapper for route error handling
- **`safeLlmCall()`** — retries, token metering, right-sized max_tokens

## Known Issues

- ~~Knowledge graph rebuild wipes safety scores~~ — FIXED: `update-graph.mjs` now auto-propagates safety scores after rebuild, and pipeline step 4 runs full safety ingestion as belt-and-suspenders
- Backfill (`backfill:history`) and live feed (`adsb:live`) contend for SQLite write locks on heavy days — `busy_timeout` handles most cases
- Pilot-aircraft links (`pilot_aircraft_link`) are city/state proximity heuristics, not FAA-authoritative
- `faa_docindex` collateral matching is fuzzy — some liens may not match to `faa_aircraft` records
- Aircraft classification (`classify-aircraft.mjs`) uses pattern matching on `common_name` — edge cases exist for rare types

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_PATH` | No | SQLite path (default: `./data/dumont.db`). Set to `/data/dumont.db` on Railway. |
| `DUMONT_DB_PATH` | No | Legacy alias for DATABASE_PATH (still works, DATABASE_PATH takes priority) |
| `ANTHROPIC_API_KEY` | Yes (server) | Claude API for LLM calls (intake, chat, SDR) |
| `VAPI_SECRET` | No | Authenticates Vapi webhook requests to `/chat/completions` |
| `ENABLE_OPENSKY` | No | Enable OpenSky Network polling (default: off) |
| `ALLOWED_ORIGINS` | No (prod: yes) | CORS origins, comma-separated |
| `NODE_ENV` | No | `production` for strict CORS, auth enforcement |

## Railway Deployment

Deployed to Railway with SQLite on a persistent volume. See `deploy-checklist.md` for full setup.

**Services** (all share volume at `/data`):

| Service | Command | Type | Schedule |
|---------|---------|------|----------|
| Web API | `npm run server` | web (port 3001) | always on |
| ADS-B Worker | `npm run adsb:live` | worker | always on |
| Pipeline | `npm run pipeline` | cron | `0 3 * * *` (3 AM UTC) |
| Health Check | `npm run health:check` | cron | `*/15 * * * *` |

**Key files**: `railway.toml`, `Dockerfile`, `.dockerignore`, `deploy-checklist.md`

**Env vars on Railway**: `DATABASE_PATH=/data/dumont.db`, `ANTHROPIC_API_KEY`, `NODE_ENV=production`, `VAPI_SECRET`

**DB path resolution** (all scripts): `DATABASE_PATH` > `DUMONT_DB_PATH` > `./data/dumont.db`

## Commands Quick Reference

```bash
npm test                    # 628 tests, 19 files
npm run typecheck           # tsc --noEmit strict
npm run sim                 # 25 deal simulation scenarios
npm run server              # Express API on :3001
npm run mcp:serve           # MCP server (stdio)
npm run dashboard           # React dashboard on :5174
npm run pipeline            # Nightly: FAA diff + classify + graph
npm run adsb:live           # Live ADS-B position streaming
npm run health:check        # Data freshness check (standalone)
npm run eval:quote          # Quote accuracy evaluation
```

## Workflow Rules

- NEVER call an operator before Guardian validates the trip
- NEVER call an operator before Quote confirms budget alignment
- NEVER present more than one quote to a client (day 1-50)
- ALWAYS log deal outcomes to memory (even failed/rejected deals)
- ALWAYS pay operators fast — #1 relationship builder
