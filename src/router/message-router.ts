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
import { z } from "zod";

// ── Operator Quote Extraction Schema ────────────────────────────────────

/** Schema for LLM-confirmed operator quote extraction. */
export const OperatorQuoteSchema = z.object({
  quotedPrice: z.number().positive(),
  currency: z.string().default("USD"),
  validUntil: z.string().optional(),
  notes: z.string().optional(),
});
export type OperatorQuote = z.infer<typeof OperatorQuoteSchema>;

/** Injectable LLM function for confirming operator quotes. */
export type QuoteExtractorFn = (messageBody: string) => Promise<OperatorQuote | null>;

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
  /**
   * LLM-confirmed quote extraction. If provided, operator quote_response
   * messages are verified by the LLM before any price enters the pipeline.
   * The regex extractPrice is used as a fast pre-check; the LLM confirms.
   */
  quoteExtractor?: QuoteExtractorFn;
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
    const patch = runExtractors(msg.body, deal);
    // Apply patch through proper channel — not direct mutation
    if (patch.trip) Object.assign(deal.trip, patch.trip);
    if (patch.client) Object.assign(deal.client, patch.client);
    if (patch.fields.length > 0) deal.updatedAt = new Date().toISOString();
    updatedFields.push(...patch.fields);
  }

  // ── Step 4: Classify intent ────────────────────────────────────────
  const senderRole = classifySender(msg, deal);
  const intent = classifyIntent(msg, deal, senderRole);
  msg.intent = intent;

  // ── Step 5: Determine action ───────────────────────────────────────
  const action = await determineAction(intent, senderRole, deal, msg, options.quoteExtractor);

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
 * Extract patch of new data from a message body.
 * Returns a patch object + list of fields that would be updated.
 * Does NOT mutate the deal — caller applies the patch via updateDealContext.
 */
export interface ExtractorPatch {
  trip?: Partial<DealContext["trip"]>;
  client?: Partial<DealContext["client"]>;
  fields: string[];
}

function runExtractors(body: string, deal: DealContext): ExtractorPatch {
  const patch: ExtractorPatch = { fields: [] };
  const tripPatch: Partial<DealContext["trip"]> = {};
  const clientPatch: Partial<DealContext["client"]> = {};

  // Pax update
  const pax = extractPax(body);
  if (pax && pax !== deal.trip.pax && pax > 0) {
    tripPatch.pax = pax;
    patch.fields.push("pax");
  }

  // Budget (only fill if currently null)
  if (!deal.client.budget) {
    const budget = extractBudget(body);
    if (budget) {
      clientPatch.budget = budget;
      patch.fields.push("budget");
    }
  }

  // Route (only fill missing endpoints)
  const [dep, arr] = extractRoute(body);
  if (dep && !deal.trip.departure) {
    tripPatch.departure = dep;
    patch.fields.push("departure");
  }
  if (arr && !deal.trip.arrival) {
    tripPatch.arrival = arr;
    patch.fields.push("arrival");
  }

  // Aircraft class (only fill if null)
  if (!deal.trip.aircraftClass) {
    const cls = extractAircraftClass(body);
    if (cls) {
      tripPatch.aircraftClass = cls;
      patch.fields.push("aircraftClass");
    }
  }

  if (Object.keys(tripPatch).length > 0) patch.trip = tripPatch;
  if (Object.keys(clientPatch).length > 0) patch.client = clientPatch;

  return patch;
}

// ── Action determination ─────────────────────────────────────────────────

async function determineAction(
  intent: MessageIntent,
  senderRole: SenderRole,
  deal: DealContext,
  msg: Message,
  quoteExtractor?: QuoteExtractorFn,
): Promise<RouteAction> {
  switch (intent) {
    case "quote_response": {
      if (senderRole === "operator") {
        // Fast pre-check: regex extraction
        const regexPrice = extractPrice(msg.body);
        if (regexPrice === null) return { type: "none" };

        // If LLM extractor is available, confirm the price before it enters the pipeline
        if (quoteExtractor) {
          const confirmed = await quoteExtractor(msg.body);
          if (confirmed) {
            return { type: "advance_to_quoted", operatorPrice: confirmed.quotedPrice };
          }
          // LLM couldn't confirm — flag for human review
          return { type: "flag_for_human", reason: `Regex found $${regexPrice.toLocaleString()} but LLM could not confirm operator quote. Manual review required.` };
        }

        // No LLM extractor (tests, cold start) — use regex price
        return { type: "advance_to_quoted", operatorPrice: regexPrice };
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
