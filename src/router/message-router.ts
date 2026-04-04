/**
 * Message Router — the air traffic controller for all inbound messages.
 * Per spec: communication-layer.md FR-2, section 2.1.
 *
 * Flow:
 * 1. Match to existing deal via ThreadMatcher (or create new via intake)
 * 2. Append to conversation
 * 3. Run extractors on EVERY inbound (update pax, budget, etc.)
 * 4. Classify intent
 * 5. Advance stage on operator quote or client confirmation
 */

import type { Message, MessageIntent } from "../schemas/message.js";
import type { Conversation } from "../schemas/conversation.js";
import { createConversation, addMessageToConversation } from "../schemas/conversation.js";
import type { DealContext } from "../schemas/deal-context.js";
import { matchThread } from "./thread-matcher.js";
import type { ActiveDeal } from "./thread-matcher.js";
import { classifySender, classifyIntent } from "./intent-classifier.js";
import type { SenderRole } from "./intent-classifier.js";
import { extractPax, extractBudget, extractRoute, extractAircraftClass } from "../capabilities/intake.js";

// ── Router Result ────────────────────────────────────────────────────────

export interface RouteResult {
  /** The matched or newly created deal. */
  deal: DealContext;
  /** The deal's conversation. */
  conversation: Conversation;
  /** Whether a new deal was created. */
  isNewDeal: boolean;
  /** Classified intent of the message. */
  intent: MessageIntent;
  /** Sender's role relative to the deal. */
  senderRole: SenderRole;
  /** Fields updated from extractor re-run. */
  updatedFields: string[];
  /** Action to take (for orchestrator). */
  action: RouteAction;
}

export type RouteAction =
  | { type: "none" }
  | { type: "advance_to_quoted"; operatorPrice: number }
  | { type: "close_deal"; result: "closed" }
  | { type: "close_deal"; result: "client_declined" }
  | { type: "activate_backup" }
  | { type: "flag_for_human"; reason: string }
  | { type: "create_new_deal" };

// ── Router Options ───────────────────────────────────────────────────────

export interface RouterOptions {
  /**
   * Create a new DealContext from the message body.
   * In production this calls intake(). Injectable for testing.
   */
  createDeal: (messageBody: string) => Promise<DealContext>;
}

// ── Main Router ──────────────────────────────────────────────────────────

/**
 * Route an inbound message to the correct deal and determine the action.
 *
 * @param msg - The inbound message.
 * @param activeDeals - All tracked deals with their conversations.
 * @param options - Injectable deal creation function.
 * @returns RouteResult with deal, intent, and action.
 */
export async function routeMessage(
  msg: Message,
  activeDeals: ActiveDeal[],
  options: RouterOptions,
): Promise<RouteResult> {
  // ── Step 1: Thread matching ────────────────────────────────────────
  let matched = matchThread(msg, activeDeals);
  let isNewDeal = false;

  if (!matched) {
    // Create new deal from message
    const deal = await options.createDeal(msg.body);
    const conversation = createConversation(deal.id);
    matched = { deal, conversation };
    isNewDeal = true;
  }

  const { deal, conversation } = matched;

  // Link message to deal
  msg.dealId = deal.id;

  // ── Step 2: Append to conversation ─────────────────────────────────
  addMessageToConversation(conversation, msg);

  // ── Step 3: Run extractors on EVERY inbound ────────────────────────
  const updatedFields: string[] = [];
  if (msg.direction === "inbound") {
    const extracted = runExtractors(msg.body, deal);
    updatedFields.push(...extracted);
  }

  // ── Step 4: Classify intent ────────────────────────────────────────
  const senderRole = classifySender(msg, deal);
  const intent = classifyIntent(msg, deal, senderRole);
  msg.intent = intent;

  // ── Step 5: Determine action ───────────────────────────────────────
  const action = determineAction(intent, senderRole, deal, msg);

  return {
    deal,
    conversation,
    isNewDeal,
    intent,
    senderRole,
    updatedFields,
    action,
  };
}

// ── Extractors (re-run on every inbound) ─────────────────────────────────

/**
 * Re-run intake extractors on a message body. Updates deal fields if new
 * data is found that the deal doesn't already have.
 * Returns list of fields that were updated.
 */
function runExtractors(body: string, deal: DealContext): string[] {
  const updated: string[] = [];

  // Pax update
  const pax = extractPax(body);
  if (pax && pax !== deal.trip.pax && pax > 0) {
    deal.trip.pax = pax;
    updated.push("pax");
  }

  // Budget (only fill if currently null)
  if (!deal.client.budget) {
    const budget = extractBudget(body);
    if (budget) {
      deal.client.budget = budget;
      updated.push("budget");
    }
  }

  // Route (only fill missing endpoints)
  const [dep, arr] = extractRoute(body);
  if (dep && !deal.trip.departure) {
    deal.trip.departure = dep;
    updated.push("departure");
  }
  if (arr && !deal.trip.arrival) {
    deal.trip.arrival = arr;
    updated.push("arrival");
  }

  // Aircraft class (only fill if null)
  if (!deal.trip.aircraftClass) {
    const cls = extractAircraftClass(body);
    if (cls) {
      deal.trip.aircraftClass = cls;
      updated.push("aircraftClass");
    }
  }

  deal.updatedAt = new Date().toISOString();
  return updated;
}

// ── Action determination ─────────────────────────────────────────────────

function determineAction(
  intent: MessageIntent,
  senderRole: SenderRole,
  deal: DealContext,
  msg: Message,
): RouteAction {
  switch (intent) {
    case "quote_response": {
      if (senderRole === "operator") {
        const price = extractPrice(msg.body);
        if (price !== null) {
          return { type: "advance_to_quoted", operatorPrice: price };
        }
      }
      return { type: "none" };
    }

    case "confirmation": {
      if (senderRole === "client" && deal.stage === "presented") {
        return { type: "close_deal", result: "closed" };
      }
      return { type: "none" };
    }

    case "decline": {
      if (senderRole === "client") {
        return { type: "close_deal", result: "client_declined" };
      }
      if (senderRole === "operator") {
        return { type: "activate_backup" };
      }
      return { type: "none" };
    }

    case "negotiation": {
      return { type: "flag_for_human", reason: "Negotiation detected. Requires human handling." };
    }

    default:
      return { type: "none" };
  }
}

// ── Price extraction ─────────────────────────────────────────────────────

/**
 * Extract a dollar amount from message body.
 * Supports "$28,000", "$28000", "$28k", "28 thousand".
 */
function extractPrice(body: string): number | null {
  // "$XXk" — check before bare dollar to avoid matching "$32" from "$32k"
  const kMatch = body.match(/\$\s*(\d+)\s*k\b/i);
  if (kMatch) {
    return parseInt(kMatch[1]!, 10) * 1000;
  }

  // "XX thousand"
  const thousandMatch = body.match(/(\d+)\s*thousand/i);
  if (thousandMatch) {
    return parseInt(thousandMatch[1]!, 10) * 1000;
  }

  // "$XX,XXX" or "$XXXXX"
  const dollarMatch = body.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (dollarMatch) {
    const val = parseFloat(dollarMatch[1]!.replace(/,/g, ""));
    if (val > 0) return val;
  }

  return null;
}
