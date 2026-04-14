/**
 * PostgreSQL connection pool for Supabase.
 *
 * Reads SUPABASE_DATABASE_URL from env. Exports pool access and a query helper.
 * Used by migrate-pg.ts and the PostgresAdapter in database-adapter.ts.
 */

import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.SUPABASE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DATABASE_URL not set. Add it to .env or set it as an environment variable.",
    );
  }

  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: false },
  });

  pool.on("error", (err) => {
    console.error("[pg] Unexpected pool error:", err.message);
  });

  return pool;
}

/** Convenience: run a single query against the pool. */
export async function query(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult> {
  return getPool().query(sql, params);
}

/** Close the pool for graceful shutdown. */
export async function closePg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
