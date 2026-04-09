/**
 * Database singleton — SQLite via better-sqlite3.
 *
 * Opens ./data/dumont.db (or path from DUMONT_DB_PATH env var).
 * WAL mode for read performance. Foreign keys enabled.
 * Runs migrations on first access.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { runMigrations } from "./migrations.js";

let db: Database.Database | null = null;

/**
 * Get the database instance. Creates and migrates on first call.
 * @param dbPath - Override path (used in tests for temp databases).
 */
export function getDb(dbPath?: string): Database.Database {
  if (db && !dbPath) return db;

  const resolvedPath = dbPath ?? process.env.DUMONT_DB_PATH ?? path.resolve("./data/dumont.db");

  const instance = new Database(resolvedPath);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");

  runMigrations(instance);

  // Only cache the singleton for the default path
  if (!dbPath) {
    db = instance;
  }

  return instance;
}

/**
 * Close the singleton database connection.
 * Call on process shutdown or in tests for cleanup.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Create an isolated in-memory database for testing.
 * Fully migrated, independent from the singleton.
 */
export function createTestDb(): Database.Database {
  return getDb(":memory:");
}
