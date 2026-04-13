/**
 * Standalone Health Check — data freshness monitor.
 *
 * Queries the same data as GET /api/health/data, prints a human-readable
 * report, and exits with a code suitable for cron/external monitoring:
 *
 *   Exit 0 = green (all fresh)
 *   Exit 1 = yellow (something >6h stale)
 *   Exit 2 = red (something >24h stale or dead feed)
 *
 * Usage:
 *   npm run health:check
 *
 * Designed to be called by cron, Railway health checks, or a future
 * Telegram/email alerting integration.
 */

import { getDb, closeDb } from "../memory/database.js";
import { getDataHealth, getFeedHealth } from "./health-queries.js";
import type { TrafficLight } from "./health-queries.js";

function icon(status: TrafficLight): string {
  if (status === "green") return "\x1b[32mOK\x1b[0m";
  if (status === "yellow") return "\x1b[33mWARN\x1b[0m";
  return "\x1b[31mCRIT\x1b[0m";
}

function main() {
  const db = getDb();
  const health = getDataHealth(db);
  const feed = getFeedHealth(db);

  const hr = "─".repeat(60);
  console.log(`\n  ${hr}`);
  console.log(`  DUMONT HEALTH CHECK — ${new Date().toISOString()}`);
  console.log(`  ${hr}\n`);

  // ── Sources ──────────────────────────────────────────────────────────
  for (const src of health.sources) {
    const age = src.ageHours != null ? `${src.ageHours}h ago` : "never";
    console.log(`  [${icon(src.status)}]  ${src.name.padEnd(15)} ${age.padEnd(12)} ${src.detail}`);
  }

  // ── Feed ─────────────────────────────────────────────────────────────
  const feedIcon = feed.feedStatus === "alive" ? "\x1b[32mOK\x1b[0m"
    : feed.feedStatus === "stale" ? "\x1b[33mWARN\x1b[0m"
    : "\x1b[31mCRIT\x1b[0m";
  console.log(`  [${feedIcon}]  ${"adsb_live".padEnd(15)} ${feed.latestPositionAge.padEnd(12)} ${feed.positionsLast5Min} pos/5min, ${feed.positionsLastHour.toLocaleString()} pos/hr, ${feed.legsToday} legs today`);

  // ── Knowledge Graph ──────────────────────────────────────────────────
  console.log(`\n  Knowledge Graph: ${health.knowledgeGraph.totalTracked.toLocaleString()} tracked, ${health.knowledgeGraph.charterTracked.toLocaleString()} charter, ${health.knowledgeGraph.ghostCount} ghosts`);
  console.log(`  FAA Registry:    ${health.faaRegistry.totalAircraft.toLocaleString()} aircraft`);

  // ── Eval ─────────────────────────────────────────────────────────────
  if (health.eval.latestAccuracyPct != null) {
    console.log(`  Last Eval:       ${health.eval.latestAccuracyPct}% accuracy (${health.eval.latestRunDate})`);
  }

  // ── Pipeline ─────────────────────────────────────────────────────────
  if (health.pipeline.lastRun) {
    console.log(`  Last Pipeline:   ${health.pipeline.status} (${health.pipeline.lastRun})`);
  }

  // ── Overall ──────────────────────────────────────────────────────────
  console.log(`\n  ${hr}`);
  const overallIcon = health.overall === "green" ? "\x1b[32mGREEN\x1b[0m"
    : health.overall === "yellow" ? "\x1b[33mYELLOW\x1b[0m"
    : "\x1b[31mRED\x1b[0m";
  console.log(`  OVERALL: ${overallIcon}`);

  // ── Alerts ───────────────────────────────────────────────────────────
  const reds = health.sources.filter((s) => s.status === "red");
  const yellows = health.sources.filter((s) => s.status === "yellow");

  if (reds.length > 0) {
    console.log(`\n  \x1b[31mCRITICAL:\x1b[0m ${reds.map((s) => `${s.name} (${s.detail})`).join(", ")}`);
  }
  if (feed.feedStatus === "dead") {
    console.log(`  \x1b[31mCRITICAL:\x1b[0m ADS-B live feed is dead — no positions received`);
  }
  if (yellows.length > 0) {
    console.log(`  \x1b[33mWARNING:\x1b[0m ${yellows.map((s) => `${s.name} (${s.detail})`).join(", ")}`);
  }
  if (feed.feedStatus === "stale") {
    console.log(`  \x1b[33mWARNING:\x1b[0m ADS-B live feed is stale — last position ${feed.latestPositionAge}`);
  }

  console.log(`  ${hr}\n`);

  closeDb();

  // Exit code: 0=green, 1=yellow, 2=red
  const exitCode = health.overall === "red" || feed.feedStatus === "dead" ? 2
    : health.overall === "yellow" || feed.feedStatus === "stale" ? 1
    : 0;
  process.exit(exitCode);
}

main();
