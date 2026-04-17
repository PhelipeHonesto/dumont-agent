# Phase 7 schema additions — apply to Supabase

`scripts/phase7-verify.ts` writes one row per quality check into
`data_quality_runs`, grouped by `run_id`. The existing schema only had
columns for the holistic `analytics/data-quality.ts` run (seven integer
counts + `overall_status`). Per-check rows need six new nullable
columns plus two indexes.

`src/memory/schema-pg.sql` (table 30) has been updated. This doc is the
copy-paste bridge to the live Supabase instance. Idempotent — safe to
paste a second time.

## Apply

Paste into the Supabase SQL Editor:

```sql
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS run_id UUID;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS check_name TEXT;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS threshold TEXT;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS actual_value TEXT;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS context JSONB;

-- Enforce the status domain (skip if already applied — the CHECK
-- allows NULL for legacy holistic rows)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'data_quality_runs_status_check'
  ) THEN
    ALTER TABLE data_quality_runs
      ADD CONSTRAINT data_quality_runs_status_check
      CHECK (status IS NULL OR status IN ('pass', 'fail'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_dqr_run_id ON data_quality_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_dqr_check_name ON data_quality_runs(check_name);
```

## Backward compatibility

- Legacy `analytics/data-quality.ts` rows leave all six new columns
  NULL and continue to work.
- New Phase 7 verify rows set the six columns and leave the seven
  integer count columns at their defaults.
- The existing `overall_status` NOT NULL CHECK stays — Phase 7 verify
  maps `pass → 'green'`, `fail → 'red'`.

## Query examples

Latest verify run:
```sql
SELECT run_id, run_at, check_name, status, actual_value
FROM data_quality_runs
WHERE run_id = (
  SELECT run_id FROM data_quality_runs
  WHERE run_id IS NOT NULL
  ORDER BY run_at DESC LIMIT 1
)
ORDER BY check_name;
```

All failed checks, newest first:
```sql
SELECT run_at, check_name, threshold, actual_value, context
FROM data_quality_runs
WHERE status = 'fail'
ORDER BY run_at DESC LIMIT 50;
```
