/**
 * Positions query router — Phase 2 Deliverable 3.
 *
 * Abstracts hot (Postgres, last 48h) vs cold (S3 Parquet via DuckDB, >48h).
 * Callers only know about queryPositions(); routing is internal.
 *
 * Routing boundary: 48h (matches the adsb_positions TTL + packager cadence).
 * Queries that span the boundary hit both tiers in parallel, then dedupe.
 *
 * The `handlers` export exists so tests can mock queryHot/queryCold without
 * vi.mock'ing the whole module. In production this is a no-op indirection.
 */

import duckdb from "duckdb";
import { getPool } from "../memory/pg-database.js";

// ── Public contract ────────────────────────────────────────────────────────

export interface PositionQuery {
  icao?: string | string[];           // filter to specific aircraft (lowercase hex)
  timeStart: number;                  // unix epoch seconds (inclusive)
  timeEnd: number;                    // unix epoch seconds (exclusive)
  bbox?: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  limit?: number;                     // default 100 000, max 1 000 000
}

export interface PositionResult {
  icao_hex: string;
  tail_number: string | null;
  callsign: string | null;
  latitude: number;
  longitude: number;
  altitude_ft: number | null;
  ground_speed_kts: number | null;
  heading: number | null;
  vertical_rate: number | null;
  on_ground: boolean;
  nearest_airport: string | null;
  timestamp: number;
}

export const HOT_BOUNDARY_SECONDS = 48 * 3600;
export const DEFAULT_LIMIT = 100_000;
export const MAX_LIMIT = 1_000_000;

// Input validation — reject anything that can't be safely interpolated into
// the DuckDB SQL builder (which doesn't parameterize IN-lists cleanly).
const ICAO_RE = /^[0-9a-f~]{6,7}$/i;

function clampLimit(raw?: number): number {
  if (raw == null || !Number.isFinite(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

function normalizeIcaos(icao?: string | string[]): string[] | null {
  if (!icao) return null;
  const arr = Array.isArray(icao) ? icao : [icao];
  const out: string[] = [];
  for (const i of arr) {
    if (!ICAO_RE.test(i)) throw new Error(`invalid icao_hex: "${i}" (expected 6-7 hex chars)`);
    out.push(i.toLowerCase());
  }
  return out.length > 0 ? out : null;
}

// ── Hot path (Postgres) ────────────────────────────────────────────────────

export async function queryHot(q: PositionQuery): Promise<PositionResult[]> {
  const icaos = normalizeIcaos(q.icao);
  const limit = clampLimit(q.limit);
  const bbox = q.bbox ?? null;

  const pool = getPool();
  const sql = `
    SELECT icao_hex, tail_number, callsign, latitude, longitude,
           altitude_ft, ground_speed_kts, heading, vertical_rate,
           on_ground, nearest_airport, timestamp
    FROM adsb_positions
    WHERE timestamp >= $1 AND timestamp < $2
      AND ($3::text[] IS NULL OR icao_hex = ANY($3))
      AND ($4::real IS NULL OR latitude BETWEEN $4 AND $5)
      AND ($6::real IS NULL OR longitude BETWEEN $6 AND $7)
    ORDER BY timestamp
    LIMIT $8
  `;
  const res = await pool.query(sql, [
    q.timeStart,
    q.timeEnd,
    icaos,
    bbox?.minLat ?? null, bbox?.maxLat ?? null,
    bbox?.minLon ?? null, bbox?.maxLon ?? null,
    limit,
  ]);
  return res.rows.map(toResult);
}

// ── Cold path (DuckDB reading S3 Parquet) ──────────────────────────────────

let duckDb: duckdb.Database | null = null;
let duckInitPromise: Promise<duckdb.Database> | null = null;

async function getDuck(): Promise<duckdb.Database> {
  if (duckDb) return duckDb;
  if (duckInitPromise) return duckInitPromise;

  duckInitPromise = new Promise<duckdb.Database>((resolve, reject) => {
    const db = new duckdb.Database(":memory:");
    // httpfs + credential_chain picks up standard AWS creds (env, ~/.aws, instance role).
    const setup = `
      INSTALL httpfs;
      LOAD httpfs;
      SET s3_region='us-east-1';
      CREATE SECRET IF NOT EXISTS osa_s3 (TYPE S3, PROVIDER credential_chain, REGION 'us-east-1');
    `;
    db.exec(setup, (err) => {
      if (err) { reject(err); return; }
      duckDb = db;
      resolve(db);
    });
  });
  return duckInitPromise;
}

function daysInRange(startEpoch: number, endEpoch: number): string[] {
  const days: string[] = [];
  const startMs = startEpoch * 1000;
  const endMs = endEpoch * 1000;
  const cur = new Date(startMs);
  cur.setUTCHours(0, 0, 0, 0);
  while (cur.getTime() < endMs) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

function parquetUrl(day: string): string {
  const [y, m] = day.split("-");
  return `s3://osa-dumont-backup/raw/adsb-osa/${y}/${m}/${day}/positions.parquet`;
}

/** Consult osa_position_archive for days with status='complete'. Days that
 *  weren't packaged (feed outage, pre-D2 era) are filtered out silently. */
async function availableParquetDays(days: string[]): Promise<string[]> {
  if (days.length === 0) return [];
  const pool = getPool();
  try {
    const res = await pool.query(
      `SELECT date FROM osa_position_archive
       WHERE status='complete' AND date = ANY($1)`,
      [days],
    );
    const have = new Set(res.rows.map((r) => r.date as string));
    return days.filter((d) => have.has(d));
  } catch {
    // Table may not exist yet in dev environments — treat as "no parquet available"
    return [];
  }
}

export async function queryCold(q: PositionQuery): Promise<PositionResult[]> {
  const icaos = normalizeIcaos(q.icao);
  const limit = clampLimit(q.limit);

  const allDays = daysInRange(q.timeStart, q.timeEnd);
  const availableDays = await availableParquetDays(allDays);
  if (availableDays.length === 0) return [];

  const urls = availableDays.map(parquetUrl);
  const urlList = urls.map((u) => `'${u}'`).join(",");

  const filters: string[] = [
    `timestamp >= ${Math.floor(q.timeStart)}`,
    `timestamp < ${Math.floor(q.timeEnd)}`,
  ];
  if (icaos) {
    filters.push(`icao_hex IN (${icaos.map((i) => `'${i}'`).join(",")})`);
  }
  if (q.bbox) {
    filters.push(`latitude BETWEEN ${q.bbox.minLat} AND ${q.bbox.maxLat}`);
    filters.push(`longitude BETWEEN ${q.bbox.minLon} AND ${q.bbox.maxLon}`);
  }

  const sql = `
    SELECT icao_hex, tail_number, callsign, latitude, longitude,
           altitude_ft, ground_speed_kts, heading, vertical_rate,
           on_ground, nearest_airport, timestamp
    FROM read_parquet([${urlList}], union_by_name=true)
    WHERE ${filters.join(" AND ")}
    ORDER BY timestamp
    LIMIT ${limit}
  `;

  const db = await getDuck();
  const rows = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    db.all(sql, (err, r) => err ? reject(err) : resolve(r as Record<string, unknown>[]));
  });
  return rows.map(toResult);
}

// ── Router ─────────────────────────────────────────────────────────────────

// Indirection so tests can swap in mocks without vi.mock'ing the module.
export const handlers = {
  queryHot,
  queryCold,
};

function dedupeAndSort(rows: PositionResult[]): PositionResult[] {
  const seen = new Set<string>();
  const out: PositionResult[] = [];
  for (const r of rows) {
    const k = `${r.icao_hex}|${r.timestamp}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

export async function queryPositions(q: PositionQuery): Promise<PositionResult[]> {
  if (q.timeEnd <= q.timeStart) return [];
  const nowEpoch = Math.floor(Date.now() / 1000);
  const hotCutoff = nowEpoch - HOT_BOUNDARY_SECONDS;

  if (q.timeEnd <= hotCutoff) {
    return handlers.queryCold(q);
  }
  if (q.timeStart >= hotCutoff) {
    return handlers.queryHot(q);
  }

  const [hot, cold] = await Promise.all([
    handlers.queryHot({ ...q, timeStart: hotCutoff }),
    handlers.queryCold({ ...q, timeEnd: hotCutoff }),
  ]);
  return dedupeAndSort([...hot, ...cold]);
}

// ── Row mapping ────────────────────────────────────────────────────────────

function toResult(r: Record<string, unknown>): PositionResult {
  const tsRaw = r.timestamp;
  const timestamp =
    typeof tsRaw === "bigint" ? Number(tsRaw) :
    typeof tsRaw === "number" ? tsRaw :
    typeof tsRaw === "string" ? parseInt(tsRaw, 10) : 0;
  return {
    icao_hex: String(r.icao_hex ?? ""),
    tail_number: (r.tail_number ?? null) as string | null,
    callsign: (r.callsign ?? null) as string | null,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    altitude_ft: r.altitude_ft == null ? null : Number(r.altitude_ft),
    ground_speed_kts: r.ground_speed_kts == null ? null : Number(r.ground_speed_kts),
    heading: r.heading == null ? null : Number(r.heading),
    vertical_rate: r.vertical_rate == null ? null : Number(r.vertical_rate),
    on_ground: Boolean(r.on_ground),
    nearest_airport: (r.nearest_airport ?? null) as string | null,
    timestamp,
  };
}

