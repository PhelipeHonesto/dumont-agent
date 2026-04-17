# Feed migration deploy plan — SQLite → Postgres (Phase 2, Deliverable 1)

Scope: cut the PM2 `feed` process over to Postgres via the rewritten
`src/ingestion/adsblol-live-worker.ts`.

Assumptions verified:
- Feed is currently stopped on Lightsail (`pm2 stop feed`).
- Supabase PG has all three target tables (`adsb_positions`, `adsb_aircraft_state`, `adsb_completed_legs`) with the schemas documented in `src/memory/schema-pg.sql`.
- `SUPABASE_DATABASE_URL` is present in `~/dumont-agent/.env` on Lightsail.

---

## 1. Pre-deploy checks (local)

Run from this repo before pushing:
```bash
npm run typecheck                # must pass
npm test                         # must pass (640 tests)
git status --short               # only expected files modified
git log --oneline -3             # sanity-check the commit about to land
```

Expected modified files:
```
M  src/analytics/wingx-engine.ts            (bulkUpsert extracted)
A  src/memory/bulk-upsert.ts                (new shared helper)
M  src/ingestion/adsblol-live-worker.ts     (PG rewrite)
A  docs/feed-migration-deploy.md            (this file)
```

## 2. Pre-deploy checks (Lightsail)

```bash
ssh lightsail "pm2 status feed | grep -E 'feed|status'"
# EXPECT: feed | stopped
# If feed is online, stop it first:
#   ssh lightsail "pm2 stop feed"

ssh lightsail "grep -E '^(DATABASE_TYPE|SUPABASE_DATABASE_URL)=' ~/dumont-agent/.env | sed 's/=.*/=<set>/'"
# EXPECT: DATABASE_TYPE=<set> and SUPABASE_DATABASE_URL=<set>

ssh lightsail "df -h ~ | tail -1"
# EXPECT: plenty of free space (positions stay in PG, not on disk here)
```

## 3. Ship code

```bash
git push                        # from local
ssh lightsail "cd ~/dumont-agent && git pull"
ssh lightsail "cd ~/dumont-agent && npm install --no-audit --no-fund"  # no new deps expected, but safe
ssh lightsail "cd ~/dumont-agent && npm run typecheck"
# EXPECT: clean typecheck on the server
```

## 4. Smoke-test one cycle on the server before restarting PM2

```bash
ssh lightsail "cd ~/dumont-agent && DATABASE_TYPE=postgres npx tsx src/ingestion/adsblol-live-worker.ts --single-cycle"
```

Expected output:
```
[adsb.lol] Starting live ADS-B ingestion worker...
[adsb.lol] Grid: 35 cells (250nm each)
[adsb.lol] Poll: 15s | Cleanup: 1h | TTL: 48h
[adsb.lol] Caches loaded: 198 airports, ~313K ICAO→tail, ~313K FAA enrichment rows
[feed] timing: fetch=<1000ms, ingest=<5000ms
[feed] cycle 1 done: ~6000 positions, N legs, <5000ms | ~77000 tracked | ...
[adsb.lol] --single-cycle complete, exiting.
```

**Abort if:**
- Fetch time > 3 s (adsb.lol or network problem — not our code)
- Ingest time > 10 s (PG problem — check pool settings)
- Any error about `DATABASE_TYPE` or `pg` module

## 5. Update PM2 entry

The existing PM2 entry runs `npx tsx src/ingestion/adsblol-live-worker.ts` with default env. Make sure `DATABASE_TYPE=postgres` is in the environment it sees. Confirm:

```bash
ssh lightsail "pm2 show feed | grep -E 'exec cwd|env|script'"
```

If PM2 is configured with `--update-env` or reads from `.env`, restarting will pick up `DATABASE_TYPE=postgres`. Otherwise:

```bash
ssh lightsail "pm2 delete feed && cd ~/dumont-agent && pm2 start npm --name feed -- run adsb:live --update-env"
ssh lightsail "pm2 save"
```

## 6. Start feed

```bash
ssh lightsail "pm2 start feed"
ssh lightsail "pm2 logs feed --lines 40 --nostream"
```

Expected: cycles at ~15 s intervals, each under 10 s wall, with "tracked" and "positions" climbing.

## 7. First-minute verification

From local (Mac):
```bash
set -a && source .env && set +a
npx tsx -e '
  import pg from "pg";
  const c = new pg.Client({ connectionString: process.env.SUPABASE_DATABASE_URL });
  await c.connect();
  const r = await c.query(`
    SELECT
      (SELECT COUNT(*) FROM adsb_positions
         WHERE timestamp > EXTRACT(EPOCH FROM (NOW() - INTERVAL \"2 minutes\"))) AS pos_2min,
      (SELECT COUNT(*) FROM adsb_aircraft_state
         WHERE updated_at > NOW() - INTERVAL \"2 minutes\") AS state_2min,
      (SELECT COUNT(*) FROM adsb_completed_legs
         WHERE created_at > NOW() - INTERVAL \"5 minutes\") AS legs_5min;
  `);
  console.log(r.rows[0]);
  await c.end();
'
```

Expected:
- `pos_2min` > 10,000   (two cycles worth of positions)
- `state_2min` > 5,000  (first-time inserts + upserts)
- `legs_5min` ≥ 0       (could be 0; legs only fire on airborne→idle transitions)

## 8. Rollback plan

If the feed breaks after deploy:

```bash
# Immediate: stop the broken worker
ssh lightsail "pm2 stop feed"

# Option A — revert to the pre-rewrite worker (SQLite path)
ssh lightsail "cd ~/dumont-agent && git log --oneline -5"  # find the commit before this rewrite
ssh lightsail "cd ~/dumont-agent && git revert <commit-hash> && git push"
# Then: ssh lightsail "cd ~/dumont-agent && git pull && pm2 start feed"

# Option B — hard reset to previous HEAD (only if revert won't work cleanly)
ssh lightsail "cd ~/dumont-agent && git reset --hard HEAD~1 && pm2 start feed"
```

The old code wrote to SQLite, which is untouched by this migration. Reverting immediately restores pre-change behavior with no data loss — only the new PG rows written during the broken window would need re-ingestion, which will happen naturally on the next successful cycle after rollback.

## 9. Post-deploy monitoring (first 24 h)

Every few hours, check:

```bash
ssh lightsail "pm2 status feed"                    # uptime climbing, 0 restarts
ssh lightsail "pm2 logs feed --lines 30 --nostream"  # cycles logged, no fatals
```

And from local:
```bash
npx tsx -e 'pg check query on adsb_positions row count should be growing'
```

If PM2 restart count climbs above 3 in 24 h, stop the feed and investigate the crash log.

## 10. What this deploy does NOT do

- SQLite is not dropped. `getDb()` callers still work. Full SQLite retirement is Phase 9.
- `opensky-worker.ts`, `adsblol-ingest.ts`, `history-backfill.ts`, `archive-adsb-raw.ts` still write SQLite. Those are separate phases.
- The in-SQLite rows from prior runs on Lightsail stay there. We do not delete or migrate them as part of this deploy.
- Analytics tables (`operator_market_share`, etc.) are not affected. They were already on PG; they'll now be fed by the new worker.

---

## Phase 2 Deliverable 2 — Nightly packager cron

Runs after the feed has been live for 24 h. Packages yesterday's positions
into S3 at 23:30 UTC (before the TTL cleanup deletes them).

Pre-requisites:
- `osa_position_archive` table exists in Supabase (the packager creates it
  idempotently via `CREATE TABLE IF NOT EXISTS` on first run; also in
  `src/memory/schema-pg.sql` for reference).
- `SUPABASE_DATABASE_URL` and AWS credentials present in `~/dumont-agent/.env`.
- Feed process running and writing to `adsb_positions` (verified in Section 7).

Add to Lightsail crontab (`crontab -e`):
```
30 23 * * *  cd ~/dumont-agent && DATABASE_TYPE=postgres npx tsx src/ingestion/package-positions.ts --date yesterday >> ~/package.log 2>&1
```

Expected runtime: 20–30 min for a full day (~21 M positions, ~65 K aircraft).
Outputs three S3 objects per day under `s3://osa-dumont-backup/raw/adsb-osa/YYYY/MM/YYYY-MM-DD/`:
- `positions.parquet` — 400–800 MB
- `prod-0.tar` — 400–800 MB (split into `.tar.aa` / `.tar.ab` if > 2 GB)
- `manifest.json`

**Memory profile:** the packager streams end-to-end — `pg-cursor` reads 5 K
rows at a time, `@dsnp/parquetjs.appendRow` writes row-groups incrementally,
the trace accumulator flushes one aircraft's gzipped JSON per icao-boundary,
and tar is built by shell-out to `/usr/bin/tar` which reads from disk. No
full-table in-memory buffer. Peak RSS observed in smoke tests: ~230 MB
(dominated by the 313 K-row FAA enrichment map, ~104 MB). **Safe for the
1.9 GB Lightsail instance** with substantial headroom for the feed and API
processes alongside. Hard ceiling: `MAX_PACKAGER_RSS_MB` env var (default
300 MB) — packager aborts loudly if exceeded.

Verify after first nightly run:
```bash
ssh lightsail "tail -40 ~/package.log"
aws s3 ls s3://osa-dumont-backup/raw/adsb-osa/$(date -u -v-1d +%Y/%m/%Y-%m-%d)/
```

Rollback for packager: pure reads from `adsb_positions` + writes to S3. Safe
to re-run any date; idempotent via the `ON CONFLICT (date) DO UPDATE` in the
audit table and S3 overwrites.
