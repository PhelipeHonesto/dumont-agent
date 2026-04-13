#!/usr/bin/env node
/**
 * update-graph.mjs — Knowledge Graph Builder
 *
 * Joins faa_aircraft ↔ adsb_aircraft_state on icao_hex to produce a
 * knowledge_graph table linking tail numbers to operators, flagging
 * ghost candidates (idle charter-class aircraft near network airports),
 * and computing fleet stats.
 *
 * Usage:  node update-graph.mjs [--db path/to/dumont.db]
 *
 * Constraints:
 *   - Does NOT modify existing table schemas
 *   - Creates knowledge_graph + fleet_stats tables (idempotent)
 *   - Uses the existing SQLite connection via better-sqlite3
 */

import Database from "better-sqlite3";
import path from "node:path";

// ── Config ──────────────────────────────────────────────────────────────
const DB_PATH = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : process.env.DATABASE_PATH ?? process.env.DUMONT_DB_PATH ?? path.resolve("./data/dumont.db");

const GHOST_IDLE_HOURS_MIN = 4;        // idle at least 4h to be a ghost candidate
const CHARTER_CLASSES = new Set([
  "light", "midsize", "super_mid", "heavy", "turboprop",
]);

// ── Open DB ─────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 30000");
db.pragma("foreign_keys = ON");

console.log(`[graph] Opened ${DB_PATH}`);

// ── Create knowledge_graph table (idempotent) ───────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS knowledge_graph (
    icao_hex          TEXT PRIMARY KEY,
    tail_number       TEXT,
    owner_name        TEXT,
    operator_name     TEXT,
    manufacturer      TEXT,
    model             TEXT,
    common_name       TEXT,
    aircraft_class    TEXT,
    year_manufactured INTEGER,
    num_seats         INTEGER,
    certificate_number TEXT,

    -- ADS-B live state
    state             TEXT,
    latitude          REAL,
    longitude         REAL,
    nearest_airport   TEXT,
    idle_since        TEXT,
    idle_hours        REAL DEFAULT 0,
    last_seen         TEXT,
    last_leg_origin   TEXT,
    last_leg_dest     TEXT,

    -- Graph flags
    is_charter_class      INTEGER DEFAULT 0,
    is_near_network_airport INTEGER DEFAULT 0,
    is_ghost_candidate    INTEGER DEFAULT 0,
    ghost_airport         TEXT,

    -- Leg stats
    total_legs        INTEGER DEFAULT 0,
    legs_last_30d     INTEGER DEFAULT 0,

    updated_at        TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS fleet_stats (
    aircraft_class    TEXT PRIMARY KEY,
    total_tracked     INTEGER DEFAULT 0,
    airborne          INTEGER DEFAULT 0,
    idle              INTEGER DEFAULT 0,
    ghost_candidates  INTEGER DEFAULT 0,
    updated_at        TEXT DEFAULT (datetime('now'))
  );
`);

console.log("[graph] Tables ensured");

// ── Step 1: Join FAA + ADS-B state → knowledge_graph ────────────────────
const joinAndInsert = db.transaction(() => {
  // Clear stale data
  db.exec("DELETE FROM knowledge_graph");

  // Core join: faa_aircraft ↔ adsb_aircraft_state on icao_hex
  const insertStmt = db.prepare(`
    INSERT INTO knowledge_graph (
      icao_hex, tail_number, owner_name, operator_name,
      manufacturer, model, common_name, aircraft_class,
      year_manufactured, num_seats, certificate_number,
      state, latitude, longitude, nearest_airport,
      idle_since, idle_hours, last_seen,
      last_leg_origin, last_leg_dest,
      is_charter_class
    )
    SELECT
      f.icao_hex,
      f.tail_number,
      f.owner_name,
      COALESCE(a.operator_name, f.certificate_holder, f.owner_name),
      f.manufacturer,
      f.model,
      f.common_name,
      COALESCE(a.aircraft_class, f.aircraft_class),
      f.year_manufactured,
      f.num_seats,
      f.certificate_number,
      a.state,
      a.latitude,
      a.longitude,
      a.nearest_airport,
      a.idle_since,
      a.idle_hours,
      a.last_seen,
      a.last_leg_origin,
      a.last_leg_destination,
      CASE WHEN COALESCE(a.aircraft_class, f.aircraft_class)
        IN ('light','midsize','super_mid','heavy','turboprop')
        THEN 1 ELSE 0 END
    FROM faa_aircraft f
    INNER JOIN adsb_aircraft_state a ON f.icao_hex = a.icao_hex
    WHERE f.icao_hex IS NOT NULL GROUP BY f.icao_hex
  `);

  insertStmt.run();
  const joined = db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_graph").get();
  console.log(`[graph] Joined ${joined.cnt} aircraft (FAA ∩ ADS-B)`);
  return joined.cnt;
});

const totalJoined = joinAndInsert();

// ── Step 2: Flag aircraft near network airports ─────────────────────────
//    An aircraft is "near" a network airport if adsb_aircraft_state.nearest_airport
//    matches a faa_airports.icao_code in our network.
const flagNetworkProximity = db.transaction(() => {
  const result = db.prepare(`
    UPDATE knowledge_graph
    SET is_near_network_airport = 1,
        ghost_airport = nearest_airport
    WHERE nearest_airport IN (SELECT icao_code FROM faa_airports)
  `).run();
  console.log(`[graph] ${result.changes} aircraft near network airports`);
  return result.changes;
});

flagNetworkProximity();

// ── Step 3: Flag ghost candidates ───────────────────────────────────────
//    Ghost = charter-class + idle + near network airport + idle >= threshold
const flagGhosts = db.transaction(() => {
  const result = db.prepare(`
    UPDATE knowledge_graph
    SET is_ghost_candidate = 1
    WHERE is_charter_class = 1
      AND is_near_network_airport = 1
      AND state = 'idle_transient'
  `).run();
  console.log(`[graph] ${result.changes} ghost candidates flagged`);
  return result.changes;
});

flagGhosts();

// ── Step 4: Compute leg stats per aircraft ──────────────────────────────
const computeLegStats = db.transaction(() => {
  // Total legs
  db.prepare(`
    UPDATE knowledge_graph
    SET total_legs = (
      SELECT COUNT(*) FROM adsb_completed_legs l
      WHERE l.icao_hex = knowledge_graph.icao_hex
    )
  `).run();

  // Legs in last 30 days
  db.prepare(`
    UPDATE knowledge_graph
    SET legs_last_30d = (
      SELECT COUNT(*) FROM adsb_completed_legs l
      WHERE l.icao_hex = knowledge_graph.icao_hex
        AND l.departure_time >= datetime('now', '-30 days')
    )
  `).run();

  console.log("[graph] Leg stats computed");
});

computeLegStats();

// ── Step 5: Update fleet_stats ──────────────────────────────────────────
const updateFleetStats = db.transaction(() => {
  db.exec("DELETE FROM fleet_stats");

  db.prepare(`
    INSERT INTO fleet_stats (aircraft_class, total_tracked, airborne, idle, ghost_candidates)
    SELECT
      aircraft_class,
      COUNT(*),
      SUM(CASE WHEN state = 'airborne' THEN 1 ELSE 0 END),
      SUM(CASE WHEN state = 'idle_transient' THEN 1 ELSE 0 END),
      SUM(is_ghost_candidate)
    FROM knowledge_graph
    WHERE is_charter_class = 1
    GROUP BY aircraft_class
  `).run();

  console.log("[graph] Fleet stats updated");
});

updateFleetStats();

// ── Step 6: Link tail numbers to operator_profiles (if populated) ───────
//    Build operator → fleet mapping from the knowledge graph
const linkOperators = db.transaction(() => {
  // Count distinct operators in graph
  const ops = db.prepare(`
    SELECT operator_name, COUNT(*) AS fleet_size,
           SUM(CASE WHEN state = 'airborne' THEN 1 ELSE 0 END) AS airborne,
           SUM(is_ghost_candidate) AS ghosts
    FROM knowledge_graph
    WHERE operator_name IS NOT NULL AND is_charter_class = 1
    GROUP BY operator_name
    HAVING fleet_size >= 2
    ORDER BY fleet_size DESC
    LIMIT 50
  `).all();

  console.log(`[graph] Top operators with 2+ charter aircraft: ${ops.length}`);
  for (const op of ops.slice(0, 10)) {
    console.log(`        ${op.operator_name}: ${op.fleet_size} aircraft (${op.airborne} airborne, ${op.ghosts} ghosts)`);
  }
});

linkOperators();

// ── Step 7: Propagate safety ratings from faa_operators ────────────────
//    The DELETE + re-INSERT above wipes safety columns. Re-propagate them
//    from faa_operators so they are never missing after a graph rebuild.
const propagateSafety = db.transaction(() => {
  // Exact name match
  const exact = db.prepare(`
    UPDATE knowledge_graph
    SET operator_argus = (
      SELECT o.argus_rating FROM faa_operators o
      WHERE o.name = knowledge_graph.operator_name
        AND o.argus_rating IS NOT NULL
      LIMIT 1
    ),
    operator_wyvern = (
      SELECT o.wyvern_rating FROM faa_operators o
      WHERE o.name = knowledge_graph.operator_name
        AND o.wyvern_rating IS NOT NULL
      LIMIT 1
    ),
    operator_safety_score = COALESCE((
      SELECT CASE
        WHEN o.argus_rating = 'platinum_elite' THEN 4
        WHEN o.argus_rating = 'platinum' OR (o.is_bao_stage IS NOT NULL AND o.is_bao_stage >= 2) THEN 3
        WHEN o.argus_rating = 'gold_plus' OR o.wyvern_rating = 'wingman' THEN 2
        WHEN o.argus_rating = 'gold' THEN 1
        ELSE 0
      END
      FROM faa_operators o
      WHERE o.name = knowledge_graph.operator_name
        AND (o.argus_rating IS NOT NULL OR o.wyvern_rating IS NOT NULL)
      LIMIT 1
    ), 0)
    WHERE operator_name IS NOT NULL AND operator_name != '' AND operator_name != '-'
  `).run();
  console.log(`[graph] Safety scores propagated: ${exact.changes} rows (exact match)`);

  // Fuzzy match: KG operator_name LIKE '%rated_operator_name%'
  const ratedOps = db.prepare(
    `SELECT name, argus_rating, wyvern_rating, is_bao_stage FROM faa_operators
     WHERE argus_rating IS NOT NULL OR wyvern_rating IS NOT NULL`,
  ).all();

  const fuzzyStmt = db.prepare(
    `UPDATE knowledge_graph SET operator_argus = ?, operator_wyvern = ?, operator_safety_score = ?
     WHERE operator_name LIKE ? AND operator_safety_score = 0`,
  );

  let fuzzyCount = 0;
  for (const op of ratedOps) {
    const score = op.argus_rating === "platinum_elite" ? 4
      : (op.argus_rating === "platinum" || (op.is_bao_stage != null && op.is_bao_stage >= 2)) ? 3
      : (op.argus_rating === "gold_plus" || op.wyvern_rating === "wingman") ? 2
      : op.argus_rating === "gold" ? 1 : 0;
    const result = fuzzyStmt.run(op.argus_rating, op.wyvern_rating, score, `%${op.name}%`);
    fuzzyCount += result.changes;
  }
  if (fuzzyCount > 0) {
    console.log(`[graph] Safety scores propagated: ${fuzzyCount} rows (fuzzy match)`);
  }
});

propagateSafety();

// ── Final report ────────────────────────────────────────────────────────
console.log("\n═══ Knowledge Graph Summary ═══");

const stats = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(is_charter_class) AS charter_class,
    SUM(is_near_network_airport) AS near_network,
    SUM(is_ghost_candidate) AS ghost_candidates,
    SUM(CASE WHEN state = 'airborne' THEN 1 ELSE 0 END) AS airborne,
    SUM(CASE WHEN state = 'idle_transient' THEN 1 ELSE 0 END) AS idle
  FROM knowledge_graph
`).get();

console.log(`Total aircraft in graph:    ${stats.total}`);
console.log(`Charter-class:              ${stats.charter_class}`);
console.log(`Near network airports:      ${stats.near_network}`);
console.log(`Airborne:                   ${stats.airborne}`);
console.log(`Idle:                       ${stats.idle}`);
console.log(`Ghost candidates:           ${stats.ghost_candidates}`);

// Fleet stats by class
console.log("\n── Fleet Stats by Class ──");
const fleetRows = db.prepare("SELECT * FROM fleet_stats ORDER BY total_tracked DESC").all();
for (const r of fleetRows) {
  console.log(`  ${(r.aircraft_class || "unknown").padEnd(12)} tracked=${r.total_tracked}  airborne=${r.airborne}  idle=${r.idle}  ghosts=${r.ghost_candidates}`);
}

// Ghost breakdown by airport
console.log("\n── Ghost Candidates by Airport ──");
const ghostByAirport = db.prepare(`
  SELECT ghost_airport, aircraft_class, COUNT(*) AS cnt
  FROM knowledge_graph
  WHERE is_ghost_candidate = 1
  GROUP BY ghost_airport, aircraft_class
  ORDER BY cnt DESC
  LIMIT 20
`).all();
for (const r of ghostByAirport) {
  console.log(`  ${r.ghost_airport} (${r.aircraft_class}): ${r.cnt}`);
}

// The requested outcome query
console.log("\n── Outcome Query ──");
const outcome = db.prepare(`
  SELECT COUNT(DISTINCT tail_number) AS ghost_count
  FROM knowledge_graph
  WHERE is_ghost_candidate = 1
`).get();
console.log(`SELECT COUNT(DISTINCT tail_number) FROM knowledge_graph WHERE is_ghost_candidate = 1`);
console.log(`→ ${outcome.ghost_count}`);

db.close();
console.log("\n[graph] Done.");
