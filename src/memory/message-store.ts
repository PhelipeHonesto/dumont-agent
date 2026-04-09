/**
 * Message Store — SQLite-backed persistence for all messages.
 * Same pattern as DealStore. Used by thread matcher for lookups.
 * Per spec: communication-layer.md FR-8 (Data Capture).
 *
 * Migration from JSON: public API is identical.
 */

import type Database from "better-sqlite3";
import type { Message } from "../schemas/message.js";
import { getDb } from "./database.js";

// ── Typed Row Interface ──────────────────────────────────────────────────

interface MessageRow {
  id: string;
  deal_id: string | null;
  channel: string;
  direction: string;
  sender: string;
  recipient: string | null;
  from_name: string | null;
  subject: string | null;
  body: string;
  body_html: string | null;
  attachments: string;
  drafted_by: string | null;
  approved_by: string | null;
  edit_distance: number | null;
  original_draft: string | null;
  received_at: string | null;
  drafted_at: string | null;
  approved_at: string | null;
  sent_at: string | null;
  response_to_id: string | null;
  response_time_ms: number | null;
  thread_id: string | null;
  intent: string | null;
  parsed_data: string | null;
  confidence: number | null;
  confidence_level: string | null;
  platform_message_id: string | null;
  platform_metadata: string | null;
}

// ── Row ↔ Message conversion ─────────────────────────────────────────

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    dealId: row.deal_id,
    channel: row.channel as Message["channel"],
    direction: row.direction as Message["direction"],
    from: row.sender,
    to: row.recipient,
    fromName: row.from_name,
    subject: row.subject,
    body: row.body,
    bodyHtml: row.body_html,
    attachments: JSON.parse(row.attachments),
    draftedBy: row.drafted_by as Message["draftedBy"],
    approvedBy: row.approved_by,
    editDistance: row.edit_distance,
    originalDraft: row.original_draft,
    receivedAt: row.received_at,
    draftedAt: row.drafted_at,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    responseToId: row.response_to_id,
    responseTimeMs: row.response_time_ms,
    threadId: row.thread_id,
    intent: row.intent as Message["intent"],
    parsedData: row.parsed_data ? JSON.parse(row.parsed_data) : null,
    confidence: row.confidence,
    confidenceLevel: row.confidence_level as Message["confidenceLevel"],
    platformMessageId: row.platform_message_id,
    platformMetadata: row.platform_metadata ? JSON.parse(row.platform_metadata) : null,
  };
}

// ── MessageStore ─────────────────────────────────────────────────────────

export class MessageStore {
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

  /** Persist a message. */
  saveMessage(message: Message): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, deal_id, channel, direction, sender, recipient,
        from_name, subject, body, body_html, attachments,
        drafted_by, approved_by, edit_distance, original_draft,
        received_at, drafted_at, approved_at, sent_at,
        response_to_id, response_time_ms, thread_id,
        intent, parsed_data, confidence, confidence_level,
        platform_message_id, platform_metadata
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `).run(
      message.id, message.dealId, message.channel, message.direction, message.from, message.to,
      message.fromName, message.subject, message.body, message.bodyHtml, JSON.stringify(message.attachments),
      message.draftedBy, message.approvedBy, message.editDistance, message.originalDraft,
      message.receivedAt, message.draftedAt, message.approvedAt, message.sentAt,
      message.responseToId, message.responseTimeMs, message.threadId,
      message.intent, message.parsedData ? JSON.stringify(message.parsedData) : null,
      message.confidence, message.confidenceLevel,
      message.platformMessageId, message.platformMetadata ? JSON.stringify(message.platformMetadata) : null,
    );
  }

  /** Get all messages for a deal. */
  getByDealId(dealId: string): Message[] {
    return this.db.prepare(
      "SELECT * FROM messages WHERE deal_id = ?",
    ).all(dealId).map((r) => rowToMessage(r as MessageRow));
  }

  /** Get a single message by its ID. */
  getByMessageId(id: string): Message | null {
    const row = this.db.prepare(
      "SELECT * FROM messages WHERE id = ?",
    ).get(id) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  /** Get messages by sender contact (phone or email). */
  getByContact(contact: string, limit?: number): Message[] {
    const needle = contact.toLowerCase();
    // Use SQL LIKE for substring matching, same behavior as the old filter
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE LOWER(sender) = ? OR LOWER(sender) LIKE ?",
    ).all(needle, `%${needle}%`) as MessageRow[];
    const results = rows.map(rowToMessage);
    return limit ? results.slice(-limit) : results;
  }

  /** Get all messages (for edit memory queries). */
  getAll(): Message[] {
    return this.db.prepare("SELECT * FROM messages").all().map((r) => rowToMessage(r as MessageRow));
  }

  /** Total message count. */
  get count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
