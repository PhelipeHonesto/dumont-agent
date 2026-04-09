/**
 * Call Store — SQLite-backed persistence for call records.
 * Same pattern as DealStore and MessageStore.
 * Per spec: communication-layer.md FR-5.
 *
 * Migration from JSON: public API is identical.
 */

import type Database from "better-sqlite3";
import type { Call } from "../schemas/call.js";
import { getDb } from "./database.js";

// ── Typed Row Interface ──────────────────────────────────────────────────

interface CallRow {
  call_id: string;
  deal_id: string;
  direction: string;
  participants: string;
  started_at: string;
  ended_at: string | null;
  duration_sec: number | null;
  transcript: string;
  detected_entities: string;
  summary: string | null;
  recording_url: string | null;
  recording_expires_at: string | null;
}

// ── Row ↔ Call conversion ────────────────────────────────────────────────

function rowToCall(row: CallRow): Call {
  return {
    callId: row.call_id,
    dealId: row.deal_id,
    direction: row.direction as Call["direction"],
    participants: JSON.parse(row.participants),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSec: row.duration_sec,
    transcript: JSON.parse(row.transcript),
    detectedEntities: JSON.parse(row.detected_entities),
    summary: row.summary,
    recordingUrl: row.recording_url,
    recordingExpiresAt: row.recording_expires_at,
  };
}

// ── CallStore ────────────────────────────────────────────────────────────

export class CallStore {
  private readonly db: Database.Database;

  constructor(pathOrDb?: string | Database.Database) {
    if (typeof pathOrDb === "object" && pathOrDb !== null) {
      this.db = pathOrDb;
    } else {
      this.db = getDb(pathOrDb);
    }
  }

  /** Expose the database instance for transactions across stores. */
  getDatabase(): Database.Database { return this.db; }

  /** Persist a call record. */
  saveCall(call: Call): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO calls (
        call_id, deal_id, direction, participants,
        started_at, ended_at, duration_sec,
        transcript, detected_entities, summary,
        recording_url, recording_expires_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
    `).run(
      call.callId, call.dealId, call.direction, JSON.stringify(call.participants),
      call.startedAt, call.endedAt, call.durationSec,
      JSON.stringify(call.transcript), JSON.stringify(call.detectedEntities), call.summary,
      call.recordingUrl, call.recordingExpiresAt,
    );
  }

  /** Get all calls for a deal. */
  getByDealId(dealId: string): Call[] {
    return this.db.prepare(
      "SELECT * FROM calls WHERE deal_id = ?",
    ).all(dealId).map((r) => rowToCall(r as CallRow));
  }

  /** Get a single call by ID. */
  getById(callId: string): Call | null {
    const row = this.db.prepare(
      "SELECT * FROM calls WHERE call_id = ?",
    ).get(callId) as CallRow | undefined;
    return row ? rowToCall(row) : null;
  }

  /** Total call count. */
  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM calls").get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
