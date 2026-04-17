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

## Health endpoints

- `GET /health` — cheap liveness (always 200 if event loop alive)
- `GET /ready` — readiness; runs `SELECT 1` against Postgres with 2s timeout, returns 503 on failure. Point PM2 / LB here.

## npm scripts

| Script | Purpose |
|--------|---------|
| `test` | 681 tests, 25 files (vitest) |
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
| `ingest:safety` | ARGUS / Wyvern / IS-BAO safety ratings |
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
