/**
 * Webhook Deduplication — prevents duplicate processing from provider retries.
 *
 * Webhook providers (Vapi, Resend) retry if they don't get a 200 within ~10s.
 * If an LLM call takes 15s, the webhook retries and we process twice.
 *
 * Pattern: check idempotency key → return 200 immediately → process async.
 * Keys expire after 24 hours.
 */

import type Database from "better-sqlite3";
import { getDb } from "./database.js";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const TTL_HOURS = 24;

export class WebhookDedup {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
    this.startCleanup();
  }

  /**
   * Check if a webhook has already been processed.
   * If not seen, marks it as processed and returns false.
   * If already seen, returns true (caller should skip processing).
   */
  isDuplicate(key: string): boolean {
    const existing = this.db.prepare(
      "SELECT 1 FROM processed_webhooks WHERE idempotency_key = ?",
    ).get(key) as { "1": number } | undefined;

    if (existing) return true;

    this.db.prepare(
      "INSERT OR IGNORE INTO processed_webhooks (idempotency_key) VALUES (?)",
    ).run(key);

    return false;
  }

  /** Remove entries older than 24 hours. */
  cleanup(): void {
    this.db.prepare(
      `DELETE FROM processed_webhooks WHERE processed_at < datetime('now', '-${TTL_HOURS} hours')`,
    ).run();
  }

  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /** Stop the cleanup timer (for testing). */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
