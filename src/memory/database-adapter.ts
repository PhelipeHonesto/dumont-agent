/**
 * Database Adapter — unified interface for SQLite and PostgreSQL.
 *
 * SQLiteAdapter: wraps better-sqlite3 (synchronous, current behavior)
 * PostgresAdapter: wraps pg Pool (async — Phase 2 will convert callers)
 *
 * Usage:
 *   DATABASE_TYPE=sqlite  → SQLiteAdapter (default, all existing code)
 *   DATABASE_TYPE=postgres → PostgresAdapter (requires SUPABASE_DATABASE_URL)
 *
 * Phase 1: existing code continues using getDb() from database.ts (SQLite).
 * The adapter is the foundation for Phase 2 migration.
 */

import type BetterSqlite3 from "better-sqlite3";
import type pg from "pg";

// ── Abstract Interface ──────────────────────────────────────────────────────

export interface PreparedStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
}

export interface DatabaseAdapter {
  /** Execute a query that returns rows. */
  queryAll(sql: string, params?: unknown[]): unknown[];

  /** Execute a query that returns one row. */
  queryGet(sql: string, params?: unknown[]): unknown;

  /** Execute a statement (INSERT/UPDATE/DELETE). */
  exec(sql: string, params?: unknown[]): void;

  /** Prepare a statement for repeated use (SQLite-style API). */
  prepare(sql: string): PreparedStatement;

  /** Run a function inside a transaction. */
  transaction<T>(fn: () => T): T;

  /** Close the connection. */
  close(): void;

  /** The backend type. */
  readonly type: "sqlite" | "postgres";
}

// ── SQLite Adapter ──────────────────────────────────────────────────────────

export class SQLiteAdapter implements DatabaseAdapter {
  readonly type = "sqlite" as const;

  constructor(private db: BetterSqlite3.Database) {}

  queryAll(sql: string, params?: unknown[]): unknown[] {
    return this.db.prepare(sql).all(...(params ?? []));
  }

  queryGet(sql: string, params?: unknown[]): unknown {
    return this.db.prepare(sql).get(...(params ?? []));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.db.prepare(sql);
    return {
      get: (...params: unknown[]) => stmt.get(...params),
      all: (...params: unknown[]) => stmt.all(...params),
      run: (...params: unknown[]) => stmt.run(...params),
    };
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

// ── PostgreSQL Adapter ──────────────────────────────────────────────────────
// Phase 1: provides async methods. The prepare() and transaction() methods
// throw if called synchronously — Phase 2 converts callers to async.

/**
 * Convert SQLite ? placeholders to PostgreSQL $1, $2, ... style.
 * Handles ? inside strings by tracking quote state.
 */
export function sqliteToPostgresParams(sql: string): string {
  let idx = 0;
  let inString = false;
  let result = "";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'" && sql[i - 1] !== "\\") {
      inString = !inString;
      result += ch;
    } else if (ch === "?" && !inString) {
      idx++;
      result += `$${idx}`;
    } else {
      result += ch;
    }
  }

  return result;
}

/**
 * Convert SQLite-specific SQL to PostgreSQL equivalents.
 */
export function sqliteToPostgresSql(sql: string): string {
  let result = sqliteToPostgresParams(sql);
  // datetime('now') → NOW()
  result = result.replace(/datetime\('now'\)/gi, "NOW()");
  // datetime('now', '-N hours') → NOW() - INTERVAL 'N hours'
  result = result.replace(
    /datetime\('now',\s*'(-?\d+\s+\w+)'\)/gi,
    (_match, interval: string) => `NOW() + INTERVAL '${interval}'`,
  );
  // GLOB → LIKE (approximate — GLOB is case-sensitive, LIKE is not in PG by default)
  // This is a known limitation; exact GLOB semantics need ~ regex in PG
  result = result.replace(/\bNOT GLOB\b/gi, "NOT LIKE");
  result = result.replace(/\bGLOB\b/gi, "LIKE");
  // INSERT OR REPLACE → INSERT ... ON CONFLICT DO UPDATE
  // This is too complex for regex — callers should use proper upsert syntax for PG
  // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
  result = result.replace(/INSERT OR IGNORE/gi, "INSERT");
  return result;
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly type = "postgres" as const;

  constructor(private pool: pg.Pool) {}

  /** Async query — returns all rows. */
  async queryAllAsync(sql: string, params?: unknown[]): Promise<unknown[]> {
    const pgSql = sqliteToPostgresSql(sql);
    const result = await this.pool.query(pgSql, params);
    return result.rows;
  }

  /** Async query — returns first row. */
  async queryGetAsync(sql: string, params?: unknown[]): Promise<unknown> {
    const pgSql = sqliteToPostgresSql(sql);
    const result = await this.pool.query(pgSql, params);
    return result.rows[0] ?? undefined;
  }

  /** Async exec — runs a statement. */
  async execAsync(sql: string, params?: unknown[]): Promise<void> {
    const pgSql = sqliteToPostgresSql(sql);
    await this.pool.query(pgSql, params);
  }

  /** Async transaction. */
  async transactionAsync<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Sync interface stubs (Phase 2 will remove these) ──────────────────

  queryAll(_sql: string, _params?: unknown[]): unknown[] {
    throw new Error("PostgresAdapter.queryAll() is async — use queryAllAsync() or migrate to Phase 2");
  }

  queryGet(_sql: string, _params?: unknown[]): unknown {
    throw new Error("PostgresAdapter.queryGet() is async — use queryGetAsync() or migrate to Phase 2");
  }

  exec(_sql: string): void {
    throw new Error("PostgresAdapter.exec() is async — use execAsync() or migrate to Phase 2");
  }

  prepare(_sql: string): PreparedStatement {
    throw new Error("PostgresAdapter.prepare() not available — PostgreSQL uses async queries. Phase 2 will convert callers.");
  }

  transaction<T>(_fn: () => T): T {
    throw new Error("PostgresAdapter.transaction() is async — use transactionAsync() or migrate to Phase 2");
  }

  close(): void {
    this.pool.end().catch(() => {});
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

let adapter: DatabaseAdapter | null = null;

/**
 * Get the database adapter based on DATABASE_TYPE env var.
 * Default: sqlite (existing behavior, no changes to callers).
 */
export function getAdapter(): DatabaseAdapter {
  if (adapter) return adapter;

  const dbType = process.env.DATABASE_TYPE ?? "sqlite";

  if (dbType === "postgres") {
    // Lazy import to avoid loading pg when using sqlite
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getPool } = require("./pg-database.js") as { getPool: () => pg.Pool };
    adapter = new PostgresAdapter(getPool());
    return adapter;
  }

  // Default: SQLite via existing database.ts
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("./database.js") as { getDb: () => BetterSqlite3.Database };
  adapter = new SQLiteAdapter(getDb());
  return adapter;
}

/** Reset the adapter (for tests). */
export function resetAdapter(): void {
  adapter = null;
}
