#!/usr/bin/env node
/**
 * classify-aircraft.mjs — Fill NULL aircraft_class in faa_aircraft
 *
 * Uses common_name pattern matching based on aviation type knowledge.
 * Only classifies charter-relevant turbine aircraft: light, midsize,
 * super_mid, heavy, turboprop. Leaves GA/airline/military as NULL.
 */

import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH = process.argv.includes("--db")
  ? process.argv[process.argv.indexOf("--db") + 1]
  : process.env.DATABASE_PATH ?? process.env.DUMONT_DB_PATH ?? path.resolve("./data/dumont.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ── Classification rules ────────────────────────────────────────────────
// Each rule: [class, SQL LIKE pattern, description]
// Order matters — first match wins within the UPDATE cascade, but since
// each UPDATE targets aircraft_class IS NULL, later rules only hit unmatched rows.

const rules = [
  // ── HEAVY (large-cabin, long-range) ─────────────────────────
  ["heavy", "GULFSTREAM G650%"],
  ["heavy", "GULFSTREAM G600%"],
  ["heavy", "GULFSTREAM G500%"],
  ["heavy", "GULFSTREAM G700%"],
  ["heavy", "GULFSTREAM G-8 G800%"],
  ["heavy", "GULFSTREAM 5%"],
  ["heavy", "GULFSTREAM 4%"],
  ["heavy", "GULFSTREAM 3%"],
  ["heavy", "GULFSTREAM 2%"],
  ["heavy", "BOMBARDIER BD-700%"],        // Global Express/5000/6000/6500/7500/8000
  ["heavy", "DASSAULT Falcon 7%"],
  ["heavy", "DASSAULT Falcon 8%"],
  ["heavy", "DASSAULT Falcon 900%"],
  ["heavy", "DASSAULT Falcon 6X%"],
  ["heavy", "EMBRAER EMB-135%Legacy%"],
  ["heavy", "%Lineage%"],
  ["heavy", "CESSNA 750 Citation 10%"],    // Citation X — heavy-class range/speed

  // ── SUPER_MID (mid-large cabin, transcontinental) ───────────
  ["super_mid", "BOMBARDIER BD-100 Challenger%"],  // Challenger 300/350
  ["super_mid", "BOMBARDIER CL-600%"],              // Challenger 601/604/605
  ["super_mid", "CESSNA 680 Citation Latitude%"],
  ["super_mid", "CESSNA 680 Citation Sovereign%"],
  ["super_mid", "CESSNA 700 Citation Longitude%"],
  ["super_mid", "CESSNA 650 Citation%"],             // Citation III/VI/VII
  ["super_mid", "DASSAULT Falcon 2000%"],
  ["super_mid", "DASSAULT Falcon 200%"],
  ["super_mid", "DASSAULT Falcon 100%"],
  ["super_mid", "EMBRAER EMB545 Praetor 500%"],
  ["super_mid", "EMBRAER EMB-550 Praetor 600%"],
  ["super_mid", "GULFSTREAM AEROSPACE Gulfstream G100%"],
  ["super_mid", "GULFSTREAM G280%"],
  ["super_mid", "GULFSTREAM G-7 G400%"],
  ["super_mid", "RAYTHEON 4000 Hawker Horizon%"],
  ["super_mid", "RAYTHEON Hawker 1000%"],

  // ── MIDSIZE ─────────────────────────────────────────────────
  ["midsize", "CESSNA 560%"],              // Citation V/Ultra/Encore/XLS
  ["midsize", "CESSNA 551 Citation 2SP%"],
  ["midsize", "CESSNA 550 Citation%"],     // Citation S2/Bravo
  ["midsize", "HAWKER BEECHCRAFT Hawker%"],
  ["midsize", "LEARJET 45%"],
  ["midsize", "LEARJET 55%"],
  ["midsize", "LEARJET 60%"],
  ["midsize", "LEARJET 75%"],
  ["midsize", "EMBRAER EMB-505 Phenom 300%"],
  ["midsize", "EMBRAER EMB-500 Phenom 100%"],   // Phenom 100 is light/entry but 100E/EV bridge midsize
  ["midsize", "LEARJET 31%"],
  ["midsize", "LEARJET 25%"],
  ["midsize", "LEARJET 35%"],

  // ── LIGHT (light jets, VLJ) ─────────────────────────────────
  ["light", "CESSNA 525%"],               // CJ1/CJ2/CJ3/CJ4/M2
  ["light", "CESSNA 510 Citation Mustang%"],
  ["light", "CESSNA 500 Citation 1%"],
  ["light", "CIRRUS SF-50 Vision%"],
  ["light", "ECLIPSE 550%"],
  ["light", "ECLIPSE 500%"],
  ["light", "ECLIPSE 10%"],
  ["light", "PILATUS PC-24%"],            // light jet (Williams FJ44)
  ["light", "PREMIER%"],
  ["light", "HONDA HA-420 HondaJet%"],
  ["light", "%HondaJet%"],
  ["light", "BEECH 400 Beechjet%"],
  ["light", "SYBERJET SJ30%"],

  // ── TURBOPROP ───────────────────────────────────────────────
  ["turboprop", "PILATUS PC-12%"],
  ["turboprop", "BEECH 200 Super King Air%"],
  ["turboprop", "BEECH 300 Super King Air%"],
  ["turboprop", "BEECHCRAFT Super King Air%"],
  ["turboprop", "BEECH 90 King Air%"],
  ["turboprop", "BEECH 100 King Air%"],
  ["turboprop", "BEECH F90 King Air%"],
  ["turboprop", "BEECH B200%King Air%"],
  ["turboprop", "SOCATA TBM%"],
  ["turboprop", "CESSNA 208 Caravan%"],
  ["turboprop", "CESSNA F406 Caravan%"],
  ["turboprop", "PIPER PA-46-500TP%"],         // Meridian/M500
  ["turboprop", "PIPER PA-46-600TP%"],         // M600
  ["turboprop", "PIPER PA-46-701TP%"],         // M700 Fury
  ["turboprop", "DAHER TBM%"],
  ["turboprop", "PIAGGIO P-180 Avanti%"],
];

// ── Run classification ──────────────────────────────────────────────────
const beforeCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM faa_aircraft WHERE aircraft_class IS NULL"
).get().cnt;

console.log(`[classify] ${beforeCount} aircraft with NULL aircraft_class`);
console.log(`[classify] Applying ${rules.length} classification rules...\n`);

const updateStmt = db.prepare(`
  UPDATE faa_aircraft
  SET aircraft_class = ?, updated_at = datetime('now')
  WHERE aircraft_class IS NULL AND common_name LIKE ?
`);

let totalClassified = 0;
const classCounts = { light: 0, midsize: 0, super_mid: 0, heavy: 0, turboprop: 0 };

const classify = db.transaction(() => {
  for (const [cls, pattern] of rules) {
    const result = updateStmt.run(cls, pattern);
    if (result.changes > 0) {
      totalClassified += result.changes;
      classCounts[cls] += result.changes;
      console.log(`  ${cls.padEnd(12)} +${String(result.changes).padStart(5)}  ← ${pattern}`);
    }
  }
});

classify();

const afterCount = db.prepare(
  "SELECT COUNT(*) AS cnt FROM faa_aircraft WHERE aircraft_class IS NULL"
).get().cnt;

console.log(`\n═══ Classification Summary ═══`);
console.log(`Before:          ${beforeCount} NULL`);
console.log(`Classified:      ${totalClassified}`);
console.log(`Remaining NULL:  ${afterCount}`);
console.log(`\nBy class:`);
for (const [cls, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cls.padEnd(12)} ${count}`);
}

// Final distribution
console.log(`\n── Full aircraft_class distribution ──`);
const dist = db.prepare(`
  SELECT COALESCE(aircraft_class, '(null)') AS cls, COUNT(*) AS cnt
  FROM faa_aircraft
  GROUP BY aircraft_class
  ORDER BY cnt DESC
`).all();
for (const r of dist) {
  console.log(`  ${r.cls.padEnd(12)} ${r.cnt}`);
}

db.close();
console.log("\n[classify] Done.");
