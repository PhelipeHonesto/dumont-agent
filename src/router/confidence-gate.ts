/**
 * Confidence Gate — gatekeeper for outbound message autonomy.
 * Per spec: communication-layer.md section 2.2.
 * Pattern: Anthropic "Building Effective Agents" — human-in-the-loop with graduated autonomy.
 */

import type { Message } from "../schemas/message.js";
import type { DealContext } from "../schemas/deal-context.js";
import type { AutonomyStore } from "../memory/autonomy-store.js";

// ── Gate Decision ────────────────────────────────────────────────────────

export type GateDecision =
  | { action: "auto_send" }
  | { action: "delayed"; delaySec: number }
  | { action: "hold"; reason: string }
  | { action: "blocked"; reason: string };

// ── NEVER auto-send list (hard-coded, NOT configurable) ──────────────────

const NEVER_AUTO_SEND_INTENTS: Set<string> = new Set([
  "negotiation",
  "availability_check",
]);

/**
 * Check if a draft body contains dollar amounts.
 * Client-facing messages with prices ALWAYS require approval.
 */
function containsDollarAmount(body: string): boolean {
  return /\$\s*[\d,]+/.test(body);
}

/**
 * Determine the recipient type from the message and deal context.
 */
export function getRecipientType(
  draft: Message,
  deal: DealContext,
): "client" | "operator" {
  const to = draft.to?.toLowerCase() ?? "";
  const clientContact = deal.client.contact?.toLowerCase() ?? "";
  const operatorPhone = deal.sourcing.selectedOperator?.phone?.toLowerCase() ?? "";

  if (operatorPhone && to.includes(operatorPhone)) return "operator";
  if (clientContact && to.includes(clientContact)) return "client";

  // Default to client (safer — requires more scrutiny)
  return "client";
}

/**
 * Check if this is the first contact with a specific operator.
 * First-contact messages always require human approval.
 */
function isFirstContactWithOperator(
  draft: Message,
  deal: DealContext,
): boolean {
  if (getRecipientType(draft, deal) !== "operator") return false;
  // If the deal hasn't had any operator messages yet, it's first contact
  return deal.stage === "sourced" || deal.stage === "estimated";
}

/**
 * Evaluate a draft message and determine whether to auto-send, delay, or hold.
 * Per spec pseudocode section 2.2.
 *
 * @param draft - The outbound message to evaluate.
 * @param deal - The current deal context.
 * @param autonomyStore - Store for autonomy rules (null = always hold).
 * @returns Gate decision: auto_send, delayed, hold, or blocked.
 */
export function evaluateConfidence(
  draft: Message,
  deal: DealContext,
  autonomyStore: AutonomyStore | null,
): GateDecision {
  const recipientType = getRecipientType(draft, deal);
  const intent = draft.intent;

  // ── NEVER auto-send checks (hard-coded) ────────────────────────────

  // Dollar amounts to clients
  if (containsDollarAmount(draft.body) && recipientType === "client") {
    return { action: "blocked", reason: "Client-facing message contains pricing. Always requires approval." };
  }

  // Negotiation, availability commitments
  if (intent && NEVER_AUTO_SEND_INTENTS.has(intent)) {
    return { action: "blocked", reason: `Intent "${intent}" is in the never-auto-send list.` };
  }

  // First contact with operator
  if (isFirstContactWithOperator(draft, deal)) {
    return { action: "blocked", reason: "First contact with operator. Always requires approval." };
  }

  // ── Check earned autonomy ──────────────────────────────────────────

  if (autonomyStore && intent) {
    const isAuto = autonomyStore.isAutonomous(
      draft.channel, intent, recipientType,
    );
    if (isAuto) {
      return { action: "auto_send" };
    }
  }

  // ── Confidence-based gating ────────────────────────────────────────

  if (draft.confidenceLevel === "medium") {
    const rule = autonomyStore?.getRule(draft.channel, intent ?? "general", recipientType);
    return { action: "delayed", delaySec: rule?.maxDelaySeconds ?? 30 };
  }

  // Everything else: hold for human approval
  return { action: "hold", reason: "Awaiting broker approval." };
}
