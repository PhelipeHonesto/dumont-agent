/**
 * Health Queries — shared data freshness checks.
 *
 * Used by:
 *   - GET /api/health/data  (server route)
 *   - GET /api/health/feed  (server route)
 *   - npm run health:check  (standalone monitoring script)
 *
 * Traffic light logic:
 *   green  — all data sources fresh (within expected intervals)
 *   yellow — something >6h stale
 *   red    — something >24h stale or a feed is dead
 */

import type Database from "better-sqlite3";

// ── Types ─────────────────────────────────────────────────────────────────

export type TrafficLight = "green" | "yellow" | "red";

export interface SourceStatus {
  name: string;
  status: TrafficLight;
  lastUpdate: string | null;
  ageHours: number | null;
  detail: string;
}

export interface DataHealth {
  overall: TrafficLight;
  checkedAt: string;
  sources: SourceStatus[];
  pipeline: {
    lastRun: string | null;
    status: string | null;
    ghostCount: number;
    totalInGraph: number;
    charterTracked: number;
  };
  adsb: {
    latestPositionTs: number | null;
    positionsLastHour: number;
    legsToday: number;
  };
  faaRegistry: {
    totalAircraft: number;
    lastDiffDate: string | null;
  };
  knowledgeGraph: {
    totalTracked: number;
    charterTracked: number;
    ghostCount: number;
  };
  eval: {
    latestAccuracyPct: number | null;
    latestRunId: string | null;
    latestRunDate: string | null;
  };
}

export interface FeedHealth {
  feedStatus: "alive" | "stale" | "dead";
  positionsLast5Min: number;
  positionsLastHour: number;
  legsToday: number;
  latestPositionTs: number | null;
  latestPositionAge: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function hoursAgo(isoOrUnix: string | number | null): number | null {
  if (isoOrUnix == null) return null;
  let ms: number;
  if (typeof isoOrUnix === "number") {
    ms = isoOrUnix * 1000;
  } else {
    // SQLite datetime() returns "YYYY-MM-DD HH:MM:SS" without TZ — treat as UTC
    const normalized = isoOrUnix.includes("T") ? isoOrUnix : isoOrUnix.replace(" ", "T") + "Z";
    ms = new Date(normalized).getTime();
  }
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / (1000 * 60 * 60));
}

function ageToLight(hours: number | null): TrafficLight {
  if (hours == null) return "red";
  if (hours <= 6) return "green";
  if (hours <= 24) return "yellow";
  return "red";
}

function worstLight(statuses: TrafficLight[]): TrafficLight {
  if (statuses.includes("red")) return "red";
  if (statuses.includes("yellow")) return "yellow";
  return "green";
}

function formatAge(hours: number | null): string {
  if (hours == null) return "never";
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 24) return `${hours.toFixed(1)}h ago`;
  return `${(hours / 24).toFixed(1)}d ago`;
}

// ── Queries ───────────────────────────────────────────────────────────────

type CountRow = { cnt: number };

export function getDataHealth(db: Database.Database): DataHealth {
  const now = new Date().toISOString();

  // ── Pipeline ──────────────────────────────────────────────────────────
  const latestPipeline = db.prepare(
    `SELECT started_at, status, ghost_candidates, total_in_graph, charter_tracked
     FROM pipeline_runs ORDER BY started_at DESC LIMIT 1`,
  ).get() as {
    started_at: string; status: string;
    ghost_candidates: number; total_in_graph: number; charter_tracked: number;
  } | undefined;

  const pipelineAge = hoursAgo(latestPipeline?.started_at ?? null);
  const pipelineLight = latestPipeline
    ? (latestPipeline.status === "failed" ? "red" as const : ageToLight(pipelineAge))
    : "red" as const;

  // ── ADS-B feed ────────────────────────────────────────────────────────
  const latestPosTs = (db.prepare(
    `SELECT MAX(timestamp) as ts FROM adsb_positions`,
  ).get() as { ts: number | null })?.ts ?? null;

  const posLastHour = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_positions
     WHERE timestamp >= strftime('%s', 'now', '-1 hour')`,
  ).get() as CountRow).cnt;

  const posLast5Min = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_positions
     WHERE timestamp >= strftime('%s', 'now', '-5 minutes')`,
  ).get() as CountRow).cnt;

  const legsToday = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_completed_legs
     WHERE departure_time >= date('now')`,
  ).get() as CountRow).cnt;

  const adsbAge = hoursAgo(latestPosTs);
  const adsbLight: TrafficLight = posLast5Min > 0 ? "green"
    : posLastHour > 0 ? "yellow"
    : "red";

  // ── FAA Registry ──────────────────────────────────────────────────────
  const faaTotal = (db.prepare(
    `SELECT COUNT(*) as cnt FROM faa_aircraft`,
  ).get() as CountRow).cnt;

  const lastDiff = (db.prepare(
    `SELECT MAX(detected_at) as dt FROM faa_registry_changes`,
  ).get() as { dt: string | null })?.dt ?? null;

  const faaAge = hoursAgo(lastDiff);
  const faaLight = faaTotal > 0 ? ageToLight(faaAge) : "red" as const;

  // ── Knowledge Graph ───────────────────────────────────────────────────
  const kgTotal = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_aircraft_state`,
  ).get() as CountRow).cnt;

  const kgCharter = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_aircraft_state
     WHERE aircraft_class IN ('light','midsize','super_mid','heavy','turboprop')`,
  ).get() as CountRow).cnt;

  const kgGhosts = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_aircraft_state
     WHERE state = 'idle_transient' AND idle_hours >= 6`,
  ).get() as CountRow).cnt;

  // ── Eval ──────────────────────────────────────────────────────────────
  const latestEval = db.prepare(
    `SELECT run_id, accuracy_pct, created_at
     FROM eval_run_summaries
     WHERE scored_scenarios > 0
     ORDER BY created_at DESC LIMIT 1`,
  ).get() as { run_id: string; accuracy_pct: number; created_at: string } | undefined;

  // ── Build sources list ────────────────────────────────────────────────
  const sources: SourceStatus[] = [
    {
      name: "pipeline",
      status: pipelineLight,
      lastUpdate: latestPipeline?.started_at ?? null,
      ageHours: pipelineAge != null ? Math.round(pipelineAge * 10) / 10 : null,
      detail: latestPipeline
        ? `${latestPipeline.status}, ${latestPipeline.ghost_candidates} ghosts`
        : "No pipeline runs recorded",
    },
    {
      name: "adsb_feed",
      status: adsbLight,
      lastUpdate: latestPosTs ? new Date(latestPosTs * 1000).toISOString() : null,
      ageHours: adsbAge != null ? Math.round(adsbAge * 10) / 10 : null,
      detail: `${posLastHour.toLocaleString()} positions/hr, ${legsToday} legs today`,
    },
    {
      name: "faa_registry",
      status: faaLight,
      lastUpdate: lastDiff,
      ageHours: faaAge != null ? Math.round(faaAge * 10) / 10 : null,
      detail: `${faaTotal.toLocaleString()} aircraft, last diff ${formatAge(faaAge)}`,
    },
  ];

  const overall = worstLight(sources.map((s) => s.status));

  return {
    overall,
    checkedAt: now,
    sources,
    pipeline: {
      lastRun: latestPipeline?.started_at ?? null,
      status: latestPipeline?.status ?? null,
      ghostCount: latestPipeline?.ghost_candidates ?? 0,
      totalInGraph: latestPipeline?.total_in_graph ?? 0,
      charterTracked: latestPipeline?.charter_tracked ?? 0,
    },
    adsb: {
      latestPositionTs: latestPosTs,
      positionsLastHour: posLastHour,
      legsToday,
    },
    faaRegistry: {
      totalAircraft: faaTotal,
      lastDiffDate: lastDiff,
    },
    knowledgeGraph: {
      totalTracked: kgTotal,
      charterTracked: kgCharter,
      ghostCount: kgGhosts,
    },
    eval: {
      latestAccuracyPct: latestEval?.accuracy_pct ?? null,
      latestRunId: latestEval?.run_id ?? null,
      latestRunDate: latestEval?.created_at ?? null,
    },
  };
}

export function getFeedHealth(db: Database.Database): FeedHealth {
  const latestPosTs = (db.prepare(
    `SELECT MAX(timestamp) as ts FROM adsb_positions`,
  ).get() as { ts: number | null })?.ts ?? null;

  const posLast5Min = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_positions
     WHERE timestamp >= strftime('%s', 'now', '-5 minutes')`,
  ).get() as CountRow).cnt;

  const posLastHour = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_positions
     WHERE timestamp >= strftime('%s', 'now', '-1 hour')`,
  ).get() as CountRow).cnt;

  const legsToday = (db.prepare(
    `SELECT COUNT(*) as cnt FROM adsb_completed_legs
     WHERE departure_time >= date('now')`,
  ).get() as CountRow).cnt;

  const ageHours = hoursAgo(latestPosTs);

  const feedStatus: "alive" | "stale" | "dead" =
    posLast5Min > 0 ? "alive"
    : posLastHour > 0 ? "stale"
    : "dead";

  return {
    feedStatus,
    positionsLast5Min: posLast5Min,
    positionsLastHour: posLastHour,
    legsToday,
    latestPositionTs: latestPosTs,
    latestPositionAge: formatAge(ageHours),
  };
}
