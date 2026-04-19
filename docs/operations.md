# Operations

Runtime / DevOps reference for Dumont. CLAUDE.md links here.

## Deployment

- **AWS Lightsail**: `44.197.126.96` (static IP)
- **Domain**: `api.orangesunshineaviation.com` (Caddy + Let's Encrypt)
- **PM2 processes**: `api`, `feed`, `mcp`
- **MCP SSE endpoint**: `api.orangesunshineaviation.com/sse`
- **S3 bucket**: `osa-dumont-backup` — daily DB backups + raw Glacier archives
- **Railway**: Vapi webhook relay (verify current role before changes; `railway.toml` in repo)

## Nightly cron schedule (Lightsail)

| Time (UTC) | Script | Purpose |
|------------|--------|---------|
| 1 AM | `npm run archive:faa` | Preserve raw FAA zip to S3 Glacier before processing |
| 2 AM | S3 database backup | Snapshot PG / SQLite to `s3://osa-dumont-backup/db/` |
| 3 AM | `npm run pipeline` | FAA diff + classify + rebuild knowledge graph + safety scores |

## Manual monthly tasks

> Set a recurring calendar reminder for the 1st of each month titled "Run safety:refresh". 60 seconds of manual work.

### Safety ratings refresh

Scrape ARGUS + Wyvern operator directories, upsert to `safety_ratings` table, sync matched rows to `faa_operators`. Internal-use-only data; consumed by the Sourcing agent for operator ranking.

**Cadence**: 1st of each month. The 25-day guard in the CLI prevents accidental over-refresh; `--force` overrides it.

**Prerequisites**:
- Firecrawl Docker stack running on Mac
  - Location: `~/firecrawl/`
  - Start: `cd ~/firecrawl && docker compose up -d`
  - Verify: `curl http://localhost:3002/` returns JSON
- Mac `.env` has `SUPABASE_DATABASE_URL` set
- `DATABASE_TYPE=postgres` env var set

**Run**:
```bash
cd ~/osa/dumont-agent
set -a && source .env && set +a
export DATABASE_TYPE=postgres
npm run safety:refresh
```

**Expected output**:
- ARGUS: ~30 operators (pagination fix pending — see Known Issues)
- Wyvern Wingman: ~100 operators
- Wyvern Registered: ~190 operators
- Total: ~300–350 unique after dedup
- Match to FAA operators: ~60–80% (US Part 135)
- Runtime: 60–90 seconds total

**Verify after run**:
```sql
psql "$SUPABASE_DATABASE_URL" -c "
  SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE argus_rating IS NOT NULL) AS with_argus,
    COUNT(*) FILTER (WHERE wyvern_status IS NOT NULL) AS with_wyvern,
    COUNT(*) FILTER (WHERE certificate_number IS NOT NULL) AS matched_to_faa,
    MAX(last_scraped_at) AS last_run
  FROM safety_ratings;
"
```

**Failure handling**:
- If one source fails, the others continue (partial success is OK).
- Errors flow to Sentry via `childLogger("safety-refresh")` / `childLogger("safety-ratings-scrape")`.
- To inspect: look for `log.error` entries with `component=safety-refresh` or `component=safety-ratings-scrape`.

**After first successful run**:
- The `data/seeds/safety-ratings.json` diff report logs which operators from the old manual seed are missing from the scrape.
- Review the diff log to decide whether to delete the seed file.

## Health endpoints

- `GET /health` — cheap liveness (always 200 if event loop alive)
- `GET /ready` — readiness; runs `SELECT 1` against Postgres with 2s timeout, returns 503 on failure. Point PM2 / LB here.

## npm scripts

| Script | Purpose |
|--------|---------|
| `test` | 708 tests, 27 files (vitest) |
| `typecheck` | `tsc --noEmit` strict |
| `server` | Express API on :3001 |
| `mcp:serve` | MCP server — stdio transport, 12 tools |
| `mcp:sse` | MCP server — SSE transport on :3002 |
| `dashboard` | React dashboard on :5174 |
| `pipeline` | Nightly: FAA diff + classify + graph + safety |
| `adsb:live` | Live ADS-B position streaming (adsb.lol) |
| `opensky` | Alternate live feed (OpenSky Network) |
| `backfill:history` | Backfill ADS-B legs day by day (S3-first; GitHub fallback unless `--s3-only`) |
| `ingest:faa` | Import FAA MASTER registry (seed) |
| `ingest:faa-full` | Full FAA: MASTER + DEREG + ACFTREF + ENGINE + DOCINDEX |
| `faa:diff` | Detect FAA registry changes since last import |
| `ingest:icao` | Map ICAO hex codes to tail numbers |
| `ingest:docindex` | FAA document index (liens, bills of sale) |
| `ingest:airmen` | Airmen records + pilot-aircraft linking |
| `ingest:operators` | Full Part 135 operator database |
| `ingest:safety` | ARGUS / Wyvern / IS-BAO safety ratings (legacy JSON-seed path) |
| `safety:refresh` | Monthly scrape of ARGUS + Wyvern → `safety_ratings` → sync to `faa_operators` |
| `ingest:listings` | Scrape aircraft-for-sale listings |
| `ingest:ntsb` | NTSB accident database (80K+ records) |
| `ingest:parquet` | Generic parquet flight-data ingest (via CSV intermediate) |
| `export:targets` | Prospecting export (target_companies.csv) |
| `archive:adsb` | Stream ADS-B daily tars to S3 Glacier |
| `archive:faa` | Archive FAA registry + airmen zips to S3 |
| `analytics:build` | Build WINGX-equivalent analytics tables |
| `embeddings:build` | Build route similarity vectors (pgvector) |
| `quality:check` | Run 7 data quality checks, save to DB |
| `eval:quote` | Quote accuracy evaluation (20 scenarios) |
| `health:check` | Data freshness check (standalone) |
| `sim` | 25 deal simulation scenarios |
| `deal` | Single-deal end-to-end runner |
| `db:migrate-pg` | Create PG schema in Supabase from `schema-pg.sql` |
| `db:migrate-data` | One-shot SQLite → Supabase data migration (historical; already ran) |

## Environment variables

`.env.example` is the source of truth. Summary:

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_DATABASE_URL` | prod | Postgres connection string (password must be alphanumeric — see CLAUDE.md pitfalls) |
| `DATABASE_TYPE` | no | `postgres` or unset (SQLite default) |
| `DATABASE_PATH` | no | SQLite path for local dev (`./data/dumont.db`) |
| `ANTHROPIC_API_KEY` | server | Claude API for LLM calls |
| `SENTRY_DSN` | no | When set, error/fatal auto-capture |
| `LOG_LEVEL` | no | `info` (default); `debug` for verbose |
| `VAPI_SECRET` | no | Authenticates Vapi webhooks |
| `MCP_AUTH_TOKEN` | no | Bearer token for MCP SSE auth (unset = dev mode) |
| `ALLOWED_ORIGINS` | no | CORS allowlist, comma-separated |
| `NODE_ENV` | no | `production` → strict CORS + JSON logs |
| `GITHUB_TOKEN` | no | ADS-B archive tooling (5000 req/hr vs 60) |
| `AWS_*` | archive | Credentials for S3 uploads |

## Phase 15 — logging & observability

Structured logs via pino (`src/utils/logger.ts`), Sentry bridge on
`error` / `fatal`. See `docs/phase15-logging.md` and
`docs/phase15-step2-sentry.md`.

## Phase 7 — in-flight rebuild

Runbook at `docs/phase7-rebuild-runbook.md`. Verify with
`scripts/phase7-verify.ts` (writes results to `data_quality_runs`).
