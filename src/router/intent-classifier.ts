/**
 * Intent Classifier — determines what a message means in deal context.
 * Pure code-layer classification (no LLM). Pattern-based like intake.ts.
 * Per spec: communication-layer.md section 2.1 step 4.
 */

import type { Message, MessageIntent } from "../schemas/message.js";
import type { DealContext } from "../schemas/deal-context.js";

/** Participant role relative to the deal. */
export type SenderRole = "client" | "operator" | "unknown";

/**
 * Determine if the sender is the client, the operator, or unknown.
 * Matches message.from against deal contacts.
 */
export function classifySender(msg: Message, deal: DealContext): SenderRole {
  const from = msg.from.toLowerCase();
  const clientContact = deal.client.contact?.toLowerCase() ?? "";
  const operatorPhone = deal.sourcing.selectedOperator?.phone?.toLowerCase() ?? "";
  const operatorName = deal.sourcing.selectedOperator?.operatorName?.toLowerCase() ?? "";

  if (clientContact && (from === clientContact || from.includes(clientContact) || clientContact.includes(from))) {
    return "client";
  }
  if (operatorPhone && (from === operatorPhone || from.includes(operatorPhone))) {
    return "operator";
  }
  if (operatorName && from.includes(operatorName)) {
    return "operator";
  }
  return "unknown";
}

/**
 * Classify the intent of a message based on its content and deal stage.
 * Returns one of the MessageIntent enum values.
 *
 * @param msg - The inbound message to classify.
 * @param deal - The current deal context.
 * @param senderRole - Who sent the message (client/operator/unknown).
 * @returns The classified intent.
 */
export function classifyIntent(
  msg: Message,
  deal: DealContext,
  senderRole: SenderRole,
): MessageIntent {
  const body = msg.body.toLowerCase();

  // ── Quote response (operator provides a price) ─────────────────────
  if (senderRole === "operator" && containsPrice(body)) {
    return "quote_response";
  }

  // ── Decline from operator (not available, sold, etc.) ───────────────
  if (senderRole === "operator" && isDecline(body)) return "decline";

  // ── Confirmation (client says yes) ─────────────────────────────────
  if (senderRole === "client" && deal.stage === "presented") {
    if (isConfirmation(body)) return "confirmation";
    if (isDecline(body)) return "decline";
  }

  // ── Decline (from client at any stage) ─────────────────────────────
  if (senderRole === "client" && isDecline(body)) return "decline";

  // ── Negotiation (price discussion, counteroffers) ──────────────────
  if (isNegotiation(body)) return "negotiation";

  // ── Availability check ─────────────────────────────────────────────
  if (senderRole === "operator" && isAvailabilityResponse(body)) {
    return "availability_check";
  }

  // ── Follow-up (continuing an existing conversation) ────────────────
  if (msg.responseToId && deal.stage !== "intake") {
    return "follow_up";
  }

  // ── Info request (asking questions) ────────────────────────────────
  if (isInfoRequest(body)) return "info_request";

  // ── Quote request (new client asking for pricing) ──────────────────
  if (senderRole === "client" || senderRole === "unknown") {
    if (isQuoteRequest(body)) return "quote_request";
  }

  return "general";
}

// ── Pattern matchers ─────────────────────────────────────────────────────

function containsPrice(body: string): boolean {
  return /\$\s*[\d,]+(?:\.\d+)?/.test(body) || /\b\d{2,6}\s*(?:k|thousand|all[- ]in)\b/i.test(body);
}

function isConfirmation(body: string): boolean {
  return /\b(?:let'?s\s+do\s+it|confirm|approved?|book\s+it|go\s+ahead|yes|sounds?\s+good|we'?re?\s+in|deal)\b/i.test(body);
}

function isDecline(body: string): boolean {
  return /\b(?:pass|decline|not\s+interested|not\s+available|unavailable|too\s+(?:expensive|much|high)|cancel|no\s+(?:thanks?|thank\s+you)|can'?t\s+do\s+(?:it|that)|sold)\b/i.test(body);
}

function isNegotiation(body: string): boolean {
  return /\b(?:counter|negotiate|lower|discount|best\s+price|can\s+you\s+do|what\s+about|too\s+expensive.*(?:lighter|smaller|cheaper))\b/i.test(body);
}

function isAvailabilityResponse(body: string): boolean {
  return /\b(?:available|not\s+available|unavailable|sold|booked|aircraft\s+(?:is|not)|can\s+(?:do|confirm)|schedule)\b/i.test(body);
}

function isInfoRequest(body: string): boolean {
  return /\b(?:how\s+much|what\s+(?:would|does)|can\s+you|do\s+you|is\s+(?:it|there)|tell\s+me)\b/i.test(body) || body.includes("?");
}

function isQuoteRequest(body: string): boolean {
  return /\b(?:charter|flight|fly|quote|price|cost|book|need\s+a?\s*(?:plane|jet|aircraft))\b/i.test(body);
}
