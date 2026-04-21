# Phase 6 schema additions — apply to Supabase

Two additions shipped in Tier 3 that need to land in Supabase before Phase 7 runs:

1. Seven new columns on `knowledge_graph` (populated by
   `src/ingestion/update-graph.ts` — the migrated replacement for the old
   `update-graph.mjs`).
2. A new `fleet_stats` table (same script writes this each run).

`src/memory/schema-pg.sql` has been updated to reflect both. This doc is the
copy-paste bridge into the live Supabase instance. Both blocks are idempotent —
safe to paste a second time.

---

## Step 1 — add the missing `knowledge_graph` columns

Paste into the Supabase SQL Editor:

```sql
ALTER TABLE knowledge_graph ADD COLUMN IF NOT EXISTS is_charter_class INTEGER DEFAULT 0;
ALTER TABLE knowledge_graph ADD COLUMN IF NOT EXISTS is_near_network_airport INTEGER DEFAULT 0;
ALTER TABLE knowledge_graph ADD COLUMN IF NOT EXISTS is_ghost_candidate INTEGER DEFAULT 0;
ALTER TABLE knowledge_graph ADD COLUMN IF NOT EXISTS ghost_airport TEXT;
ALTER TABLE knowledge_graph ADD COLUMN IF NOT EXISTS total_legs INTEGER DEFAULT 0;
ALTER TABLE knowledge_graph ADD COLUMN IF NOT EXISTS legs_last_30d INTEGER DEFAULT 0;
ALTER TABLE knowledge_graph ADD COLUMN IF NOT EXISTS updated_at TEXT;
```

## Step 2 — create the `fleet_stats` table

Paste into the Supabase SQL Editor:

```sql
CREATE TABLE IF NOT EXISTS fleet_stats (
  aircraft_class TEXT PRIMARY KEY,
  total_tracked INTEGER DEFAULT 0,
  airborne INTEGER DEFAULT 0,
  idle INTEGER DEFAULT 0,
  ghost_candidates INTEGER DEFAULT 0,
  updated_at TEXT
);
```

---

## Validation

Run these right after applying the two blocks above.

### 1. Confirm the `knowledge_graph` columns are present

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'knowledge_graph'
ORDER BY ordinal_position;
```

Expected output includes all seven additions (alongside the pre-existing columns):
```
is_charter_class
is_near_network_airport
is_ghost_candidate
ghost_airport
total_legs
legs_last_30d
updated_at
```

### 2. Confirm `fleet_stats` exists

```sql
SELECT * FROM fleet_stats LIMIT 1;
```

Expected: **empty result set, no error.** An error like `relation "fleet_stats" does not exist` means Step 2 didn't apply — re-run it.

---

## Rollback (if needed)

Both operations are cheap to reverse if something goes wrong mid-deploy:

```sql
-- Drop the knowledge_graph columns:
ALTER TABLE knowledge_graph DROP COLUMN IF EXISTS is_charter_class;
ALTER TABLE knowledge_graph DROP COLUMN IF EXISTS is_near_network_airport;
ALTER TABLE knowledge_graph DROP COLUMN IF EXISTS is_ghost_candidate;
ALTER TABLE knowledge_graph DROP COLUMN IF EXISTS ghost_airport;
ALTER TABLE knowledge_graph DROP COLUMN IF EXISTS total_legs;
ALTER TABLE knowledge_graph DROP COLUMN IF EXISTS legs_last_30d;
ALTER TABLE knowledge_graph DROP COLUMN IF EXISTS updated_at;

-- Drop the fleet_stats table:
DROP TABLE IF EXISTS fleet_stats;
```

`update-graph.ts` also issues `CREATE TABLE IF NOT EXISTS` at runtime as a
safety net, so re-running the script after rollback would re-create the table
(but not the `knowledge_graph` columns — the `ALTER TABLE` is only in
`schema-pg.sql`, not in the runtime script; a re-add would need to paste
Step 1 again).
