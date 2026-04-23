/**
 * Data-quality query layer (agent-side read path).
 *
 * Mirrors the wingx-queries / wingx-engine split:
 *   - src/analytics/data-quality.ts  — compute functions (data-platform)
 *   - src/analytics/quality-queries.ts — this file, read path (agent)
 *
 * The HTTP intelligence API and other agent-side consumers read the
 * latest persisted report via this module, without pulling in the
 * compute layer. Keeps the agent ↔ data-platform boundary clean when
 * src/analytics/data-quality.ts migrates to osa-data-platform.
 */

import type Database from "better-sqlite3";

/** Get the latest quality report from the database (for API). */
export function getLatestQualityReport(
  db: Database.Database,
): Record<string, unknown> | null {
  const row = db
    .prepare(`SELECT * FROM data_quality_runs ORDER BY id DESC LIMIT 1`)
    .get() as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    runAt: row.run_at,
    overallStatus: row.overall_status,
    checks: {
      malformedTails: row.malformed_tails,
      invalidIcao: row.invalid_icao,
      duplicateLegs: row.duplicate_legs,
      orphanedRecords: row.orphaned_records,
      emptyFields: row.empty_fields,
      staleData: row.stale_data,
      anomalies: row.anomalies,
    },
    details: row.details ? JSON.parse(row.details as string) : null,
  };
}
