# Phase 7 Glacier restore log

## Purpose

The Phase 7 `adsb_completed_legs` rebuild (see `docs/known-issues.md`) reads
tars from `s3://osa-dumont-backup/raw/adsb/**`. These were archived in
`GLACIER` storage class (see `src/ingestion/archive-adsb-raw.ts:72`), which
means `GetObject` fails with `InvalidObjectState` until each object is
explicitly restored.

`scripts/s3-bulk-restore.ts` issues a batch `RestoreObject` call in the
`Bulk` tier against every Glacier tar under `raw/adsb/`, producing a
7-day restored copy in the standard tier. Once complete, the existing
`history-backfill.ts --s3-only` path works end-to-end.

Scope: `raw/adsb/` only. `raw/adsb-osa/` (our own packaged tars) is
deliberately excluded.

## Pre-execute baseline (dry-run @ 2026-04-16)

```
Total objects listed:         2926
  already_standard:            1115   0.00 GiB   (manifest.json files)
  glacier_restored:               0   0.00 GiB
  glacier_restore_pending:        0   0.00 GiB
  glacier_cold (to restore):   1811   2411.99 GiB

Estimated cost (Bulk tier, 7-day retention):
  Bulk retrieval:    $6.03
  Standard copy 7d:  $12.94
  ── Total:          $18.97
```

## Current status

- Initiated at: `2026-04-17T04:36:24Z`
- Tier: `Bulk`
- Retention: 7 days (restored copy expires ~`2026-04-24T04:36Z`)
- Requests issued: **1811** (all glacier_cold objects)
- Failures: **0**
- Request fan-out time: ~9 seconds (04:36:24 → 04:36:33, 50 concurrent workers)
- Expected restored by: `2026-04-17T09:36Z` (best case, +5 hr) — `2026-04-17T16:36Z` (worst case, +12 hr)
- Last `--check` run: _none yet — run tomorrow morning_

## How to check progress

```
npx tsx scripts/s3-bulk-restore.ts --check
```

`--check` calls `HeadObject` against every pending key in
`scripts/s3-restore-state.json`, inspects the `Restore` header
(`ongoing-request="true"` vs `"false"`), and updates the state file with
completion timestamps. Prints running totals and a rough ETA.

## What happens when restore completes

1. Objects remain in the `GLACIER` storage class but gain a temporary
   standard-tier copy valid for 7 days.
2. `GetObject` / `ListObjectsV2` work normally against the restored copies.
3. Run the Phase 7 rebuild:
   ```
   DATABASE_TYPE=postgres npx tsx src/ingestion/history-backfill.ts \
     --from 2023-12-01 --to 2026-04-15 --s3-only
   ```
   (exact date range TBD at rebuild time — `--s3-only` skips any day not
   present in S3 rather than falling back to GitHub.)
4. After 7 days, the standard copy expires and objects revert to
   Glacier-only access. If the rebuild slips past that window, re-run
   `--execute` to restore again.

## Cost summary

| Item | Unit price | Quantity | Cost |
|------|------------|----------|------|
| Bulk retrieval | $0.0025/GB | 2,412 GiB | $6.03 |
| Standard storage (7d prorated) | $0.023/GB/mo × 7/30 | 2,412 GiB | $12.94 |
| **Total** | | | **$18.97** |

Per-object `RestoreObject` request fees are negligible at this volume
(sub-$0.01).

## Resume plan if the script crashes

1. `scripts/s3-restore-state.json` is flushed every 100 requests during
   `--execute`, so progress survives crashes.
2. Re-running `--execute` picks up where it left off — objects with a
   non-null `restore_requested_at` are skipped.
3. `RestoreAlreadyInProgress` errors are treated as success (some other
   run already issued the request).
4. Rate limit: 50 concurrent `RestoreObject` calls (AWS allows 1000/sec;
   we stay well under).
