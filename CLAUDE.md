# Dumont Agent — OSA Aviation Intelligence + Charter Brokerage Engine

AI-powered charter brokerage engine and aviation intelligence platform for Orange Sunshine Aviation (OSA). Single orchestrator with callable capabilities. Ingests FAA registry, ADS-B flight data, NTSB accidents, lien records, pilot records, and market listings into PostgreSQL (Supabase). Exposes intelligence via REST API, MCP server (12 tools), and React dashboard. Brokers charter deals through an automated pipeline.

## Architecture

- **Database**: PostgreSQL on Supabase (dumont-agent project, us-east-1). SQLite at `data/dumont.db` for local dev only.
- **Express server**: port 3001, `src/server/index.ts` — REST API + Vapi voice webhook
- **MCP server**: stdio transport, `src/mcp/server.ts` — 12 tools for Claude Desktop
- **Dashboard**: Vite + React at `dashboard/`, port 5174, PWA-enabled
- **Live ADS-B worker**: `src/ingestion/adsblol-live-worker.ts` — streams from adsb.lol
- **Nightly pipeline**: `src/ingestion/pipeline.ts` — FAA diff + classify + rebuild graph
- **Analytics engine**: `src/analytics/wingx-engine.ts` — WINGX-equivalent market intelligence
- **Data quality**: `src/analytics/data-quality.ts` — 7 validation checks, traffic-light status

## Data Architecture

| Layer | Storage | Contents |
|-------|---------|----------|
| **Raw (immutable)** | S3 Glacier (`osa-dumont-backup`) | adsb.lol daily tars (2023-2026), FAA registry zips (daily), airmen zips (monthly) |
| **Organized** | PostgreSQL (Supabase) | `faa_aircraft`, `adsb_completed_legs`, `ntsb_accidents`, `faa_docindex`, `knowledge_graph` |
| **Analytics** | PostgreSQL (Supabase) | `operator_market_share`, `route_trends`, `airport_activity`, `fleet_snapshot`, `aircraft_utilization` |

## Deployment

- **AWS Lightsail**: 44.197.126.96 (static IP)
- **Domain**: api.orangesunshineaviation.com (Caddy + Let's Encrypt)
- **PM2 processes**: api, feed, mcp
- **S3 bucket**: `osa-dumont-backup` — daily DB backups + raw archives
- **Railway**: Vapi webhooks only

## Nightly Cron Schedule

| Time | Script | Purpose |
|------|--------|---------|
| 1 AM | `archive:faa` | Preserve raw FAA zip to S3 Glacier before processing |
| 2 AM | S3 database backup | SQLite snapshot to `s3://osa-dumont-backup/db/` |
| 3 AM | `pipeline` | FAA diff + classify + rebuild knowledge graph + safety scores |

## Security

- **Input sanitization**: `src/server/middleware/sanitize.ts` — tail numbers (N+1-5 alphanum), ICAO codes (4 letters), month/date formats, SQL injection patterns blocked, string length limits
- **Rate limiting**: `src/server/middleware/rate-limit.ts` — 100 req/min global, 10 req/min on analytics/routes/market endpoints, health exempt
- **CORS**: production allows `orangesunshineaviation.com` + `www` + `api` subdomains only. `http://localhost:*` in dev. `ALLOWED_ORIGINS` env var overrides.

## Database Tables (30 migrations)

| # | Table | Purpose |
|---|-------|---------|
| 1 | `_migrations` | Migration tracking |
| 2 | `deals` | Deal records — route, pricing (cents), operator, client, outcome |
| 3 | `route_intel` | Route intelligence — avg price, demand, seasonal. PK: (route, class) |
| 4 | `operator_profiles` | Operator performance — reliability, response time, pricing delta |
| 5 | `client_profiles` | Client history — spend, frequency, preferred routes/aircraft |
| 6 | `validation_ledger` | Quote validation — estimate vs actual, margin tracking |
| 7 | `deal_events` | Append-only audit trail — stage transitions |
| 8 | `messages` | Inbound/outbound messages — all channels, threading, intent |
| 9 | `calls` | Voice call sessions — participants, transcript, entities |
| 10 | `autonomy_rules` | Auto-send thresholds per channel/intent/recipient |
| 11 | `processed_webhooks` | Idempotency keys for webhook dedup |
| 12 | *(alter)* | Expands validation_ledger |
| 13 | `faa_aircraft`, `faa_operators`, `faa_airports` | FAA registry, Part 135 operators, airports |
| 14 | `adsb_positions`, `adsb_aircraft_state` | ADS-B positions + current aircraft state |
| 15 | `adsb_completed_legs` | Materialized flight legs — origin, dest, time, distance, class |
| 16 | `deal_outcomes` | Structured deal outcomes for learning loop |
| 17 | `faa_registry_changes` | Daily diff — new, deregistered, ownership change |
| 18 | `pipeline_runs` | Pipeline execution log |
| 19 | `faa_docindex` | FAA document index — liens, security agreements, bills of sale |
| 20 | `pilot_contacts`, `pilot_aircraft_link` | Airmen records + pilot-aircraft proximity links |
| 21 | `aircraft_listings` | For-sale listings — price history, days on market |
| 22 | `target_companies`, `target_contacts` | Prospecting targets |
| 23 | `eval_runs`, `eval_run_summaries` | Quote eval results + aggregate stats |
| 24 | `backfill_progress` | Historical ADS-B backfill tracking by date |
| 25 | `knowledge_graph` | Joined FAA + ADS-B view with safety scores |
| 26 | `archive_progress` | S3 raw ADS-B archive tracking by date |
| 27 | `operator_market_share`, `aircraft_utilization`, `airport_activity`, `route_trends`, `fleet_snapshot`, `fuel_burn_estimates` | WINGX-equivalent analytics tables |
| 28 | `faa_deregistered`, `faa_aircraft_types`, `faa_engine_types` | Historical deregistered aircraft, ACFTREF, ENGINE reference |
| 29 | `ntsb_accidents` | NTSB accident/incident database 1962-present |
| 30 | `data_quality_runs` | Quality check history — 7 checks, overall green/yellow/red |

## npm Scripts

| Script | Purpose |
|--------|---------|
| `test` | 628 tests, 19 files (vitest) |
| `typecheck` | `tsc --noEmit` strict |
| `server` | Express API on :3001 |
| `mcp:serve` | MCP server (stdio, 12 tools) |
| `dashboard` | React dashboard on :5174 |
| `pipeline` | Nightly: FAA diff + classify + graph + safety |
| `adsb:live` | Live ADS-B position streaming |
| `backfill:history` | Backfill ADS-B legs day by day from adsb.lol releases |
| `ingest:faa` | Import FAA MASTER registry (seed) |
| `ingest:faa-full` | Full FAA ingest: MASTER + DEREG + ACFTREF + ENGINE + DOCINDEX |
| `faa:diff` | Detect FAA registry changes since last import |
| `ingest:icao` | Map ICAO hex codes to tail numbers |
| `ingest:docindex` | FAA document index (liens, bills of sale) |
| `ingest:airmen` | Airmen records + pilot-aircraft linking |
| `ingest:operators` | Full Part 135 operator database |
| `ingest:safety` | ARGUS/Wyvern/BAO safety ratings |
| `ingest:listings` | Scrape aircraft-for-sale listings |
| `ingest:ntsb` | NTSB accident database (80K+ records, pipe-delimited) |
| `archive:adsb` | Stream ADS-B daily tars to S3 Glacier (2023-2026) |
| `archive:faa` | Archive FAA registry + airmen zips to S3 |
| `analytics:build` | Build WINGX-equivalent analytics tables |
| `quality:check` | Run 7 data quality checks, save to DB |
| `eval:quote` | Quote accuracy evaluation (20 scenarios) |
| `health:check` | Data freshness check (standalone) |
| `sim` | 25 deal simulation scenarios |
| `db:migrate-pg` | Create all 42 PostgreSQL tables in Supabase |
| `db:migrate-data` | Migrate data from SQLite → Supabase (7.86M rows) |

## API Endpoints

### Intelligence (no auth, `src/server/routes/intelligence.ts`)

| Path | Purpose |
|------|---------|
| `GET /api/aircraft/:tailNumber` | Full aircraft profile — registration, ADS-B, liens, pilots, ghost status |
| `GET /api/aircraft/:tailNumber/flights` | Flight history with origin, destination, times |
| `GET /api/airport/:icao/ghosts` | Ghost candidates near airport |
| `GET /api/fleet/stats` | Fleet summary — tracked, airborne, idle, ghost count |
| `GET /api/routes/:origin/:destination` | Route analytics — frequency, class mix, monthly trend |
| `GET /api/market/listings` | Active for-sale listings |
| `GET /api/market/transactions` | Recent FAA ownership changes |
| `GET /api/health/data` | Data freshness traffic light |
| `GET /api/health/feed` | ADS-B feed liveness |
| `GET /api/health/quality` | Latest data quality report (7 checks) |

### Analytics (no auth, rate-limited, `src/server/routes/analytics.ts`)

| Path | Purpose |
|------|---------|
| `GET /api/analytics/market?month=` | Top operators, fleet size, activity, class mix |
| `GET /api/analytics/operator/:name?months=` | Operator deep dive — utilization, routes, trend |
| `GET /api/analytics/airport/:icao?date=` | Hourly activity, peak hours, top operators |
| `GET /api/analytics/route/:origin/:dest?months=` | Monthly route trend with YoY |
| `GET /api/analytics/fleet?class=` | Fleet health — utilization rates, registrations |
| `GET /api/analytics/top-routes?month=&limit=` | Busiest routes ranked |
| `GET /api/analytics/top-operators?month=&limit=` | Most active operators ranked |
| `GET /api/analytics/fuel/:origin/:dest/:class` | Estimated fuel cost for route |

### Auth-required routes

| Path | Purpose |
|------|---------|
| `POST /chat/completions` | Vapi voice AI webhook |
| `POST /api/dumont/respond` | REST conversation endpoint |
| `POST /api/chat` | Dumont AI co-pilot SSE streaming |
| `GET /api/deals` | Deal management |
| `GET /health` | Server health check |

## MCP Tools (12 total, `src/mcp/tools.ts`)

All query database directly (no HTTP). stdio transport. Server name: `dumont-intelligence`.

| Tool | Purpose |
|------|---------|
| `lookup_aircraft` | Full aircraft profile by tail number |
| `get_flights` | Flight history for an aircraft |
| `find_ghosts` | Ghost fleet candidates near airport |
| `fleet_stats` | Fleet intelligence summary |
| `route_intel` | Route analytics between two airports |
| `active_listings` | For-sale listings |
| `recent_transactions` | FAA ownership changes |
| `data_health` | Data freshness traffic light |
| `feed_health` | ADS-B feed status |
| `market_overview` | Monthly market intelligence (WINGX-equivalent) |
| `operator_analysis` | Operator deep dive — utilization, routes, trend |
| `airport_report` | Hourly airport activity report |

## Deal Pipeline

`INTAKE → GUARDIAN → ESTIMATE → GUARDIAN → SOURCE → GUARDIAN → QUOTE → GUARDIAN → [AWAITING_REVIEW] → PRESENT → GUARDIAN → CLOSE → LEARN`

- Guardian runs after EVERY stage (continuous validation, like EGPWS)
- One quote, one operator, one deal. Never blast RFQs.
- 8-10% margins. Operators paid before departure.
- Learning loop: every deal updates route_intel, operator_profiles, client_profiles

## Code Patterns

- **All money in integer cents** — never floats for money
- **All dates as ISO strings** — `datetime('now')` (SQLite) / `NOW()` (PG)
- **Zod schemas** for validation — `src/schemas/` is source of truth
- **`getDb()`** singleton — auto-migrates on first call
- **`schema_version`** on every table — forward-compatible
- **`deal_events` is append-only** — no UPDATE, no DELETE
- **Express 5** with `asyncHandler` wrapper
- **`safeLlmCall()`** — retries, token metering

## Known Issues

- PostgreSQL migration complete (7.86M rows in Supabase). Async adapter (Phase 3) pending — code still uses sync SQLite adapter locally.
- Pilot-aircraft links are city/state proximity heuristics, not FAA-authoritative
- `faa_docindex` collateral matching is fuzzy for non-aircraft collateral types
- Aircraft classification uses pattern matching on `common_name` — edge cases for rare types
- NTSB `airport_code` uses FAA codes (e.g. ORD), not ICAO (KORD) — queries strip K-prefix for matching

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_DATABASE_URL` | Yes (prod) | PostgreSQL connection string for Supabase |
| `DATABASE_TYPE` | No | `postgres` or `sqlite` (default: sqlite) — controls which adapter `getAdapter()` returns |
| `DATABASE_PATH` | No | SQLite path for local dev (default: `./data/dumont.db`) |
| `ANTHROPIC_API_KEY` | Yes (server) | Claude API for LLM calls |
| `VAPI_SECRET` | No | Authenticates Vapi webhooks |
| `ALLOWED_ORIGINS` | No | CORS origins, comma-separated |
| `NODE_ENV` | No | `production` for strict CORS + auth |
| `GITHUB_TOKEN` | No | GitHub API auth for ADS-B archive (5000 req/hr vs 60) |
| `AWS_*` | Yes (archive) | AWS credentials for S3 uploads |

## Commands Quick Reference

```bash
npm test                    # 628 tests, 19 files
npm run typecheck           # tsc --noEmit strict
npm run server              # Express API on :3001
npm run pipeline            # Nightly: FAA diff + classify + graph
npm run adsb:live           # Live ADS-B position streaming
npm run analytics:build -- --all    # Build all analytics tables
npm run quality:check       # Run data quality validation
npm run ingest:faa-full -- --all    # Full FAA registry ingest
npm run ingest:ntsb         # NTSB accident database
npm run archive:adsb -- --year 2023 # Archive ADS-B to S3
npm run archive:faa         # Archive FAA zip to S3
npm run db:migrate-pg       # Create PG schema in Supabase
npm run db:migrate-data -- --all  # Migrate SQLite → Supabase
```

## Claude Code Guidelines (Karpathy Principles)

1. **Think Before Coding** — State assumptions explicitly. Present tradeoffs. Push back when a simpler approach exists. Stop and ask when confused rather than guessing.

2. **Simplicity First** — Minimum code that solves the problem. No speculative features, no abstractions for single-use code, no "flexibility" that wasn't requested. If 200 lines could be 50, rewrite it.

3. **Surgical Changes** — Touch only what you must. Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken. Every changed line should trace directly to the request.

4. **Goal-Driven Execution** — Define success criteria before coding. Transform tasks into verifiable goals:
   - "Add validation" → "Write tests for invalid inputs, then make them pass"
   - "Fix the bug" → "Write a test that reproduces it, then make it pass"
   - For multi-step tasks, state a plan with verification at each step.
