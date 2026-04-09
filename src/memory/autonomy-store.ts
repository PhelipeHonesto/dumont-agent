/**
 * Autonomy Store — SQLite-backed per-template approval tracking.
 * Layer: memory
 *
 * Tracks how many times a draft type was approved with zero edits.
 * After threshold (default 10), Dumont earns autonomy to auto-send.
 * Uses UNIQUE(channel, intent, recipient_type) with INSERT OR REPLACE for upserts.
 */

import type Database from "better-sqlite3";
import type { AutonomyRule } from "../schemas/channel-config.js";
import type { MessageChannel, MessageIntent } from "../schemas/message.js";
import { getDb } from "./database.js";

const DEFAULT_AUTO_SEND_AFTER = 10;
const DEFAULT_MAX_DELAY_SECONDS = 30;

// ── Typed Row Interface ──────────────────────────────────────────────────

interface AutonomyRuleRow {
  id: number;
  channel: string;
  intent: string;
  recipient_type: string;
  auto_send_enabled: number;
  auto_send_after: number;
  current_approvals: number;
  max_delay_seconds: number;
}

// ── Row ↔ AutonomyRule conversion ────────────────────────────────────────

function rowToRule(row: AutonomyRuleRow): AutonomyRule {
  return {
    channel: row.channel as MessageChannel,
    intent: row.intent as MessageIntent,
    recipientType: row.recipient_type as "client" | "operator",
    autoSendEnabled: Boolean(row.auto_send_enabled),
    autoSendAfter: row.auto_send_after,
    currentApprovals: row.current_approvals,
    maxDelaySeconds: row.max_delay_seconds,
  };
}

// ── AutonomyStore ────────────────────────────────────────────────────────

export class AutonomyStore {
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

  /**
   * Get or create the autonomy rule for a channel+intent+recipientType.
   * Creates a conservative default if none exists.
   */
  getRule(channel: MessageChannel, intent: MessageIntent, recipientType: "client" | "operator"): AutonomyRule {
    const row = this.db.prepare(
      "SELECT * FROM autonomy_rules WHERE channel = ? AND intent = ? AND recipient_type = ?",
    ).get(channel, intent, recipientType) as AutonomyRuleRow | undefined;

    if (row) return rowToRule(row);

    // Create default rule
    this.db.prepare(`
      INSERT INTO autonomy_rules (channel, intent, recipient_type, auto_send_enabled, auto_send_after, current_approvals, max_delay_seconds)
      VALUES (?, ?, ?, 0, ?, 0, ?)
    `).run(channel, intent, recipientType, DEFAULT_AUTO_SEND_AFTER, DEFAULT_MAX_DELAY_SECONDS);

    return {
      channel, intent, recipientType,
      autoSendEnabled: false,
      autoSendAfter: DEFAULT_AUTO_SEND_AFTER,
      currentApprovals: 0,
      maxDelaySeconds: DEFAULT_MAX_DELAY_SECONDS,
    };
  }

  /**
   * Record a draft approval. If editDistance === 0, increment toward autonomy.
   * If editDistance > 0, reset counter and revoke autonomy.
   *
   * @returns Whether autonomy was just graduated (newly earned).
   */
  recordApproval(
    channel: MessageChannel,
    intent: MessageIntent,
    recipientType: "client" | "operator",
    editDistance: number,
  ): boolean {
    // Ensure rule exists
    const rule = this.getRule(channel, intent, recipientType);

    if (editDistance === 0) {
      const newApprovals = rule.currentApprovals + 1;
      const shouldGraduate = newApprovals >= rule.autoSendAfter && !rule.autoSendEnabled;

      this.db.prepare(`
        UPDATE autonomy_rules
        SET current_approvals = ?, auto_send_enabled = ?
        WHERE channel = ? AND intent = ? AND recipient_type = ?
      `).run(
        newApprovals,
        shouldGraduate ? 1 : (rule.autoSendEnabled ? 1 : 0),
        channel, intent, recipientType,
      );

      return shouldGraduate;
    } else {
      // Reset on edit
      this.db.prepare(`
        UPDATE autonomy_rules
        SET current_approvals = 0, auto_send_enabled = 0
        WHERE channel = ? AND intent = ? AND recipient_type = ?
      `).run(channel, intent, recipientType);

      return false;
    }
  }

  /** Check if a template has earned autonomy. */
  isAutonomous(channel: MessageChannel, intent: MessageIntent, recipientType: "client" | "operator"): boolean {
    const rule = this.getRule(channel, intent, recipientType);
    return rule.autoSendEnabled && rule.currentApprovals >= rule.autoSendAfter;
  }

  /** Manually revoke autonomy for a template. */
  revokeAutonomy(channel: MessageChannel, intent: MessageIntent, recipientType: "client" | "operator"): void {
    // Ensure rule exists first
    this.getRule(channel, intent, recipientType);

    this.db.prepare(`
      UPDATE autonomy_rules
      SET auto_send_enabled = 0, current_approvals = 0
      WHERE channel = ? AND intent = ? AND recipient_type = ?
    `).run(channel, intent, recipientType);
  }
}
