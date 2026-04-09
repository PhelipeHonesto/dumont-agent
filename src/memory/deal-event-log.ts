/**
 * Deal Event Log — append-only audit trail for every deal lifecycle event.
 *
 * Immutable. No UPDATE, no DELETE. This is the financial compliance layer.
 * Every stage transition, Guardian pass/block, and deal close writes an event.
 *
 * Powers:
 * - Audit trail (Layer 4: what was the price when Guardian approved it?)
 * - Time-series intelligence (Layer 5: deal replay for training data)
 * - Dispute resolution (prove what happened and when)
 */

import type Database from "better-sqlite3";
import { getDb } from "./database.js";

export interface DealEvent {
  id: number;
  dealId: string;
  stage: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  schemaVersion: number;
}

export type DealEventType =
  | "stage_entered"
  | "guardian_pass"
  | "guardian_block"
  | "estimate_generated"
  | "pricewall_cleared"
  | "quote_received"
  | "deal_closed"
  | "deal_lost";

interface DealEventRow {
  id: number;
  deal_id: string;
  stage: string;
  event_type: string;
  payload: string | null;
  created_at: string;
  schema_version: number;
}

export class DealEventLog {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    this.db = typeof pathOrDb === "object" && pathOrDb !== null ? pathOrDb : getDb(pathOrDb);
  }

  /** Append an immutable event. */
  appendEvent(
    dealId: string,
    stage: string,
    eventType: DealEventType | string,
    payload?: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO deal_events (deal_id, stage, event_type, payload)
      VALUES (?, ?, ?, ?)
    `).run(
      dealId,
      stage,
      eventType,
      payload ? JSON.stringify(payload) : null,
    );
  }

  /** Get all events for a deal, ordered by creation time. */
  getEvents(dealId: string): DealEvent[] {
    return this.db.prepare(
      "SELECT * FROM deal_events WHERE deal_id = ? ORDER BY id",
    ).all(dealId).map((r) => this.rowToEvent(r as DealEventRow));
  }

  /** Get events of a specific type across all deals. */
  getEventsByType(eventType: string, limit: number = 100): DealEvent[] {
    return this.db.prepare(
      "SELECT * FROM deal_events WHERE event_type = ? ORDER BY id DESC LIMIT ?",
    ).all(eventType, limit).map((r) => this.rowToEvent(r as DealEventRow));
  }

  /** Count events for a deal. */
  getEventCount(dealId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM deal_events WHERE deal_id = ?",
    ).get(dealId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** Total event count across all deals. */
  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM deal_events").get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  private rowToEvent(row: DealEventRow): DealEvent {
    return {
      id: row.id,
      dealId: row.deal_id,
      stage: row.stage,
      eventType: row.event_type,
      payload: row.payload ? JSON.parse(row.payload) : null,
      createdAt: row.created_at,
      schemaVersion: row.schema_version,
    };
  }
}
