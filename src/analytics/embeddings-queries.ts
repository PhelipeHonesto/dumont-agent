/**
 * Agent-side reader for route similarity (pgvector).
 *
 * Compute lives in osa-data-platform's src/analytics/embeddings.ts,
 * which builds the route_vectors table. This file is the read-only
 * surface the agent HTTP API consumes — same pattern as
 * wingx-queries.ts / quality-queries.ts.
 *
 * API: GET /api/routes/:origin/:destination/similar
 */

import type pg from "pg";

export async function findSimilarRoutes(
  pool: pg.Pool,
  origin: string,
  dest: string,
  limit = 5,
): Promise<Array<Record<string, unknown>>> {
  const ref = await pool.query(
    `SELECT embedding FROM route_vectors WHERE origin_icao = $1 AND destination_icao = $2`,
    [origin, dest],
  );

  if (ref.rows.length === 0) {
    return [];
  }

  const embedding = ref.rows[0]!.embedding;

  const result = await pool.query(
    `SELECT origin_icao, destination_icao, metadata,
            embedding <-> $1 as distance
     FROM route_vectors
     WHERE NOT (origin_icao = $2 AND destination_icao = $3)
     ORDER BY embedding <-> $1
     LIMIT $4`,
    [embedding, origin, dest, limit],
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    origin: r.origin_icao,
    destination: r.destination_icao,
    distance: Math.round((r.distance as number) * 1000) / 1000,
    ...(r.metadata as Record<string, unknown>),
  }));
}
