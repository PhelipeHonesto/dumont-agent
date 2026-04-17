/**
 * PostgreSQL schema migration for Supabase.
 *
 * Reads schema-pg.sql and executes it against the Supabase database.
 * Creates all 30 tables, indexes, and seed data.
 *
 * Usage: npm run db:migrate-pg
 * Requires: SUPABASE_DATABASE_URL in .env or environment
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePg } from "./pg-database.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("migrate-pg");

// Load .env if present
try {
  const envPath = resolve(process.cwd(), ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — ok, env vars may be set directly
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log("[migrate-pg] Connecting to Supabase PostgreSQL...");

  const pool = getPool();

  // Test connection
  const testResult = await pool.query("SELECT NOW() as now");
  console.log(`[migrate-pg] Connected. Server time: ${testResult.rows[0]?.now}`);

  // Read and execute schema
  const schemaPath = resolve(__dirname, "schema-pg.sql");
  const schema = readFileSync(schemaPath, "utf-8");

  console.log("[migrate-pg] Executing schema...");
  await pool.query(schema);
  console.log("[migrate-pg] Schema executed successfully.");

  // Verify all tables exist
  const tablesResult = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const tables = tablesResult.rows.map((r) => (r as { tablename: string }).tablename);
  console.log(`\n[migrate-pg] ${tables.length} tables created:`);
  for (const t of tables) {
    console.log(`  - ${t}`);
  }

  // Verify expected tables
  const expected = [
    "_migrations", "deals", "route_intel", "operator_profiles", "client_profiles",
    "validation_ledger", "deal_events", "messages", "calls", "autonomy_rules",
    "processed_webhooks", "faa_aircraft", "faa_operators", "faa_airports",
    "adsb_positions", "adsb_aircraft_state", "adsb_completed_legs",
    "deal_outcomes", "faa_registry_changes", "pipeline_runs", "faa_docindex",
    "pilot_contacts", "pilot_aircraft_link", "aircraft_listings",
    "target_companies", "target_contacts", "eval_runs", "eval_run_summaries",
    "backfill_progress", "knowledge_graph", "archive_progress",
    "operator_market_share", "aircraft_utilization", "airport_activity",
    "route_trends", "fleet_snapshot", "fuel_burn_estimates",
    "faa_deregistered", "faa_aircraft_types", "faa_engine_types",
    "ntsb_accidents", "data_quality_runs",
  ];

  const missing = expected.filter((t) => !tables.includes(t));
  if (missing.length > 0) {
    log.error({ missing }, "expected tables missing");
  } else {
    console.log(`\n[migrate-pg] All ${expected.length} expected tables verified.`);
  }

  // Check extensions
  const extResult = await pool.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
  if (extResult.rows.length > 0) {
    console.log("[migrate-pg] pgvector extension: enabled");
  } else {
    log.warn({}, "pgvector extension NOT enabled (may need superuser)");
  }

  // Check seed data
  const fuelResult = await pool.query("SELECT COUNT(*) as cnt FROM fuel_burn_estimates");
  console.log(`[migrate-pg] Fuel burn estimates: ${(fuelResult.rows[0] as { cnt: string }).cnt} rows`);

  await closePg();
  console.log("\n[migrate-pg] Done.");
}

main().catch((err) => {
  log.fatal({ err }, "migrate-pg fatal error");
  process.exit(1);
});
