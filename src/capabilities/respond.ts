/**
 * Respond Capability — generates contextual reply drafts with edit memory.
 * Per spec: communication-layer.md FR-4, section 2.6.
 * Does NOT decide to send — only drafts. The ConfidenceGate decides delivery.
 */

import type { Message, MessageIntent, MessageChannel, ConfidenceLevel } from "../schemas/message.js";
import { generateMessageId } from "../schemas/message.js";
import type { DealContext } from "../schemas/deal-context.js";
import type { MessageStore } from "../memory/message-store.js";
import { buildEditMemoryPromptSection } from "../memory/edit-memory.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface RespondOptions {
  /** MessageStore for edit memory context. */
  messageStore?: MessageStore | null;
  /** Injectable LLM drafting function. Uses template-based drafting if not provided. */
  draftFn?: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

export interface DraftResult {
  draft: Message;
  systemPrompt: string;
  confidence: number;
  confidenceLevel: ConfidenceLevel;
}

// ── Base prompts per intent ──────────────────────────────────────────────

const BASE_PROMPTS: Record<string, string> = {
  quote_request: "You are drafting an operator outreach email for OSA Connect. Include: route, date, passengers, aircraft preference. Be professional and concise. Ask for best all-in price and availability.",
  quote_response: "You are drafting a client-facing charter quote for OSA Connect. Include: all-in price, aircraft details, what's included, validity window. Be warm but professional.",
  follow_up: "You are drafting a follow-up message for OSA Connect. Be brief, personal, and include relevant context from the deal.",
  confirmation: "You are drafting a booking confirmation for OSA Connect. Include: route, date, aircraft, total price, next steps.",
  info_request: "You are responding to an information request for OSA Connect. Be helpful, factual, and concise.",
  general: "You are drafting a message for OSA Connect. Be professional, concise, and helpful.",
};

// ── Confidence scoring ───────────────────────────────────────────────────

const CONFIDENCE_MAP: Record<string, { score: number; level: ConfidenceLevel }> = {
  quote_request: { score: 0.7, level: "medium" },
  quote_response: { score: 0.3, level: "never" },  // prices always need approval
  follow_up: { score: 0.8, level: "high" },
  confirmation: { score: 0.3, level: "never" },     // commitments always need approval
  info_request: { score: 0.6, level: "medium" },
  general: { score: 0.5, level: "low" },
};

/**
 * Build the full system prompt with base instructions + edit memory.
 */
export function buildRespondSystemPrompt(
  intent: MessageIntent,
  channel: MessageChannel,
  messageStore?: MessageStore | null,
): string {
  const base = BASE_PROMPTS[intent] ?? BASE_PROMPTS["general"]!;
  let prompt = base;

  if (messageStore) {
    prompt += buildEditMemoryPromptSection(messageStore, intent, channel);
  }

  return prompt;
}

/**
 * Generate a contextual reply draft for a deal.
 * Incorporates edit memory (broker's past corrections) into the system prompt.
 *
 * @param deal - The current deal context.
 * @param inboundMessage - The message being replied to.
 * @param intent - The intent of the reply.
 * @param options - MessageStore for edit memory, injectable LLM.
 * @returns DraftResult with the message, prompt, and confidence scoring.
 */
export async function respond(
  deal: DealContext,
  inboundMessage: Message,
  intent: MessageIntent,
  options: RespondOptions = {},
): Promise<DraftResult> {
  const { messageStore = null, draftFn } = options;
  const channel = inboundMessage.channel;

  // Build system prompt with edit memory
  const systemPrompt = buildRespondSystemPrompt(intent, channel, messageStore);

  // Build user prompt from deal context
  const userPrompt = buildUserPrompt(deal, inboundMessage, intent);

  // Generate draft
  let draftBody: string;
  if (draftFn) {
    draftBody = await draftFn(systemPrompt, userPrompt);
  } else {
    draftBody = generateTemplateDraft(deal, intent);
  }

  // Score confidence
  const conf = CONFIDENCE_MAP[intent] ?? CONFIDENCE_MAP["general"]!;

  const draft: Message = {
    id: generateMessageId(),
    dealId: deal.id,
    channel,
    direction: "outbound",
    from: "charter@osa.aero",
    to: determineRecipient(deal, intent),
    fromName: "OSA Connect",
    subject: generateSubject(deal, intent),
    body: draftBody,
    bodyHtml: null,
    attachments: [],
    draftedBy: "dumont",
    approvedBy: null,
    editDistance: null,
    originalDraft: draftBody,
    receivedAt: null,
    draftedAt: new Date().toISOString(),
    approvedAt: null,
    sentAt: null,
    responseToId: inboundMessage.id,
    responseTimeMs: null,
    threadId: inboundMessage.threadId,
    intent,
    parsedData: null,
    confidence: conf.score,
    confidenceLevel: conf.level,
    platformMessageId: null,
    platformMetadata: null,
  };

  return { draft, systemPrompt, confidence: conf.score, confidenceLevel: conf.level };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildUserPrompt(deal: DealContext, msg: Message, intent: MessageIntent): string {
  const parts: string[] = [];
  parts.push(`Deal: ${deal.trip.departure} → ${deal.trip.arrival}, ${deal.trip.date}, ${deal.trip.pax} pax`);
  if (deal.client.name) parts.push(`Client: ${deal.client.name}`);
  if (deal.sourcing.selectedOperator) parts.push(`Operator: ${deal.sourcing.selectedOperator.operatorName}`);
  if (deal.quote.osaPrice) parts.push(`Price: $${deal.quote.osaPrice.toLocaleString()}`);
  parts.push(`Intent: ${intent}`);
  parts.push(`Inbound message: "${msg.body}"`);
  return parts.join("\n");
}

function generateTemplateDraft(deal: DealContext, intent: MessageIntent): string {
  switch (intent) {
    case "quote_request":
      return `Requesting quote for ${deal.trip.departure} → ${deal.trip.arrival} on ${deal.trip.date}, ${deal.trip.pax} passengers.${deal.trip.aircraftClass ? ` Preferred: ${deal.trip.aircraftClass}.` : ""} Please provide best all-in price and availability.`;
    case "follow_up":
      return `Following up on the ${deal.trip.departure} → ${deal.trip.arrival} trip on ${deal.trip.date}. Any updates?`;
    case "info_request":
      return `Thank you for your inquiry about ${deal.trip.departure} → ${deal.trip.arrival}. We're putting together options for you.`;
    default:
      return `Regarding your ${deal.trip.departure} → ${deal.trip.arrival} charter request.`;
  }
}

function determineRecipient(deal: DealContext, intent: MessageIntent): string {
  if (intent === "quote_request" || intent === "availability_check") {
    return deal.sourcing.selectedOperator?.phone ?? "";
  }
  return deal.client.contact;
}

function generateSubject(deal: DealContext, intent: MessageIntent): string {
  const route = `${deal.trip.departure}→${deal.trip.arrival}`;
  switch (intent) {
    case "quote_request": return `Charter Quote Request: ${route} ${deal.trip.date}`;
    case "quote_response": return `Your Charter Quote: ${route}`;
    case "follow_up": return `Re: ${route} Charter`;
    case "confirmation": return `Booking Confirmed: ${route} ${deal.trip.date}`;
    default: return `OSA Connect: ${route}`;
  }
}
