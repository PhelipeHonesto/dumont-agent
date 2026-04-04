/**
 * Autonomy Store — per-template approval tracking.
 * Tracks how many times a draft type was approved with zero edits.
 * After threshold (default 10), Dumont earns autonomy to auto-send.
 * Per spec: communication-layer.md section 2.4.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { AutonomyRule } from "../schemas/channel-config.js";
import { AutonomyRuleSchema } from "../schemas/channel-config.js";
import type { MessageChannel, MessageIntent } from "../schemas/message.js";

const DEFAULT_PATH = "./data/autonomy-rules.json";
const DEFAULT_AUTO_SEND_AFTER = 10;
const DEFAULT_MAX_DELAY_SECONDS = 30;

export class AutonomyStore {
  private rules: AutonomyRule[] = [];
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf-8"));
        this.rules = Array.isArray(raw)
          ? raw.filter((r) => AutonomyRuleSchema.safeParse(r).success)
          : [];
      } catch { this.rules = []; }
    }
  }

  private save(): void {
    writeFileSync(this.path, JSON.stringify(this.rules, null, 2));
  }


  /**
   * Get or create the autonomy rule for a channel+intent+recipientType.
   * Creates a conservative default if none exists.
   */
  getRule(channel: MessageChannel, intent: MessageIntent, recipientType: "client" | "operator"): AutonomyRule {
    const existing = this.rules.find((r) =>
      r.channel === channel && r.intent === intent && r.recipientType === recipientType,
    );
    if (existing) return existing;

    const rule: AutonomyRule = {
      channel, intent, recipientType,
      autoSendEnabled: false,
      autoSendAfter: DEFAULT_AUTO_SEND_AFTER,
      currentApprovals: 0,
      maxDelaySeconds: DEFAULT_MAX_DELAY_SECONDS,
    };
    this.rules.push(rule);
    this.save();
    return rule;
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
    const rule = this.getRule(channel, intent, recipientType);

    if (editDistance === 0) {
      rule.currentApprovals += 1;
      if (rule.currentApprovals >= rule.autoSendAfter && !rule.autoSendEnabled) {
        rule.autoSendEnabled = true;
        this.save();
        return true; // graduated
      }
    } else {
      rule.currentApprovals = 0;
      rule.autoSendEnabled = false;
    }

    this.save();
    return false;
  }

  /** Check if a template has earned autonomy. */
  isAutonomous(channel: MessageChannel, intent: MessageIntent, recipientType: "client" | "operator"): boolean {
    const rule = this.getRule(channel, intent, recipientType);
    return rule.autoSendEnabled && rule.currentApprovals >= rule.autoSendAfter;
  }

  /** Manually revoke autonomy for a template. */
  revokeAutonomy(channel: MessageChannel, intent: MessageIntent, recipientType: "client" | "operator"): void {
    const rule = this.getRule(channel, intent, recipientType);
    rule.autoSendEnabled = false;
    rule.currentApprovals = 0;
    this.save();
  }
}
