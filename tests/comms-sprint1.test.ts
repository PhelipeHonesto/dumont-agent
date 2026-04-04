/**
 * Tests for Communication Layer Sprint 1:
 * Message schemas, Thread Matcher, Message Router, Intent Classifier.
 *
 * Per spec acceptance criteria (FR-1, FR-2, FR-7).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { MessageSchema, generateMessageId } from "../src/schemas/message.js";
import type { Message, MessageIntent } from "../src/schemas/message.js";
import { ConversationSchema, createConversation, addMessageToConversation } from "../src/schemas/conversation.js";
import { CallSchema, TranscriptChunkSchema, DetectedEntitySchema } from "../src/schemas/call.js";
import { AutonomyRuleSchema, ChannelConfigSchema } from "../src/schemas/channel-config.js";
import { matchThread } from "../src/router/thread-matcher.js";
import type { ActiveDeal } from "../src/router/thread-matcher.js";
import { classifyIntent, classifySender } from "../src/router/intent-classifier.js";
import { routeMessage } from "../src/router/message-router.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import { advanceStage } from "../src/orchestrator/stage-transitions.js";
import type { DealContext } from "../src/schemas/deal-context.js";

// ── Helpers ──────────────────────────────────────────────────────────────

beforeEach(() => _resetDealCounter());

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: generateMessageId(),
    dealId: null,
    channel: "email",
    direction: "inbound",
    from: "client@example.com",
    to: "charter@osa.aero",
    fromName: null,
    subject: null,
    body: "I need a flight from Teterboro to Palm Beach",
    bodyHtml: null,
    attachments: [],
    draftedBy: null,
    approvedBy: null,
    editDistance: null,
    originalDraft: null,
    receivedAt: new Date().toISOString(),
    draftedAt: null,
    approvedAt: null,
    sentAt: null,
    responseToId: null,
    responseTimeMs: null,
    threadId: null,
    intent: null,
    parsedData: null,
    confidence: null,
    confidenceLevel: null,
    platformMessageId: null,
    platformMetadata: null,
    ...overrides,
  };
}

function makeDeal(overrides?: {
  stage?: DealContext["stage"];
  clientContact?: string;
  operatorPhone?: string;
  operatorName?: string;
  updatedAt?: string;
}): DealContext {
  const ctx = createDealContext("live");
  updateDealContext(ctx, {
    client: {
      name: "Test Client",
      contact: overrides?.clientContact ?? "client@example.com",
      type: "new", budget: { min: 25000, max: 40000 },
      substitutionPref: null, qualified: true, qualificationReason: "Qualified.",
    },
    trip: {
      departure: "KTEB", arrival: "KPBI", date: "2026-04-15",
      pax: 4, aircraftClass: "light", aircraftType: null,
      isRoundTrip: false, specialRequirements: [],
    },
  });
  if (overrides?.operatorPhone || overrides?.operatorName) {
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: {
          operatorId: "op_001", operatorName: overrides.operatorName ?? "Elite Aviation",
          phone: overrides.operatorPhone ?? "+1-555-0100",
          baseAirport: "KTEB", aircraftType: "Phenom 300E", aircraftTail: null,
          score: 0.85, scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 },
          distanceToDeparture: 0,
        },
      },
    });
  }
  // Advance to target stage
  if (overrides?.stage) {
    const path: Record<string, string[]> = {
      qualified: ["qualified"],
      estimated: ["qualified", "estimated"],
      sourced: ["qualified", "estimated", "sourced"],
      quoted: ["qualified", "estimated", "sourced", "quoted"],
      presented: ["qualified", "estimated", "sourced", "quoted", "presented"],
    };
    for (const s of path[overrides.stage] ?? []) {
      advanceStage(ctx, s as DealContext["stage"]);
    }
  }
  if (overrides?.updatedAt) ctx.updatedAt = overrides.updatedAt;
  return ctx;
}

function makeActiveDeal(overrides?: Parameters<typeof makeDeal>[0]): ActiveDeal {
  const deal = makeDeal(overrides);
  const conversation = createConversation(deal.id);
  return { deal, conversation };
}

async function defaultCreateDeal(_body: string): Promise<DealContext> {
  return createDealContext("live");
}

// ── Schema Validation ────────────────────────────────────────────────────

describe("schema validation", () => {
  it("MessageSchema validates a well-formed message", () => {
    const msg = makeMsg();
    expect(MessageSchema.safeParse(msg).success).toBe(true);
  });

  it("MessageSchema rejects invalid channel", () => {
    const msg = { ...makeMsg(), channel: "pigeon" };
    expect(MessageSchema.safeParse(msg).success).toBe(false);
  });

  it("ConversationSchema validates an empty conversation", () => {
    const conv = createConversation("deal_001");
    expect(ConversationSchema.safeParse(conv).success).toBe(true);
  });

  it("CallSchema validates a minimal call", () => {
    const call = {
      callId: "call_001", dealId: "deal_001", direction: "outbound_to_operator",
      participants: [{ name: "Phelipe", role: "broker", phone: "+1-555-0000" }],
      startedAt: new Date().toISOString(), endedAt: null, durationSec: null,
      transcript: [], detectedEntities: [], summary: null,
      recordingUrl: null, recordingExpiresAt: null,
    };
    expect(CallSchema.safeParse(call).success).toBe(true);
  });

  it("DetectedEntitySchema validates a price entity", () => {
    const entity = {
      type: "price", value: "$28,000", raw: "twenty-eight thousand",
      speaker: "counterparty", confidence: 0.95, timestampMs: 12000,
    };
    expect(DetectedEntitySchema.safeParse(entity).success).toBe(true);
  });

  it("AutonomyRuleSchema validates defaults", () => {
    const rule = {
      channel: "email", intent: "follow_up", recipientType: "client",
      autoSendEnabled: false, autoSendAfter: 10, currentApprovals: 0, maxDelaySeconds: 30,
    };
    expect(AutonomyRuleSchema.safeParse(rule).success).toBe(true);
  });

  it("ChannelConfigSchema validates", () => {
    const cfg = {
      channel: "email", enabled: true, rateLimitPerHour: 50,
      currentHourCount: 0, currentHourStart: null,
    };
    expect(ChannelConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it("generateMessageId produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageId()));
    expect(ids.size).toBe(100);
  });
});

// ── Conversation ─────────────────────────────────────────────────────────

describe("conversation", () => {
  it("tracks messages and updates metrics", () => {
    const conv = createConversation("deal_001");
    const msg1 = makeMsg({ channel: "email", responseTimeMs: 5000 });
    const msg2 = makeMsg({ channel: "bland_text", responseTimeMs: 3000 });

    addMessageToConversation(conv, msg1);
    addMessageToConversation(conv, msg2);

    expect(conv.touchpointCount).toBe(2);
    expect(conv.channelsUsed).toContain("email");
    expect(conv.channelsUsed).toContain("bland_text");
    expect(conv.avgResponseTimeMs).toBe(4000);
  });
});

// ── Thread Matcher ───────────────────────────────────────────────────────

describe("thread matcher", () => {
  it("matches by responseToId (email In-Reply-To)", () => {
    const ad = makeActiveDeal({ clientContact: "client@example.com" });
    const originalMsg = makeMsg({ id: "msg_original" });
    addMessageToConversation(ad.conversation, originalMsg);

    const reply = makeMsg({ responseToId: "msg_original" });
    const match = matchThread(reply, [ad]);
    expect(match).not.toBeNull();
    expect(match!.deal.id).toBe(ad.deal.id);
  });

  it("matches by phone number", () => {
    const ad = makeActiveDeal({ clientContact: "+1-555-1234" });
    const msg = makeMsg({ from: "+1-555-1234" });
    const match = matchThread(msg, [ad]);
    expect(match).not.toBeNull();
    expect(match!.deal.id).toBe(ad.deal.id);
  });

  it("matches by email address", () => {
    const ad = makeActiveDeal({ clientContact: "sarah@chen.com" });
    const msg = makeMsg({ from: "sarah@chen.com" });
    const match = matchThread(msg, [ad]);
    expect(match).not.toBeNull();
  });

  it("returns null for unknown sender (new deal)", () => {
    const ad = makeActiveDeal({ clientContact: "existing@client.com" });
    const msg = makeMsg({ from: "totally-new@person.com" });
    expect(matchThread(msg, [ad])).toBeNull();
  });

  it("most recent deal wins when multiple match same contact", () => {
    const older = makeActiveDeal({ clientContact: "client@example.com", updatedAt: "2026-04-01T10:00:00.000Z" });
    const newer = makeActiveDeal({ clientContact: "client@example.com", updatedAt: "2026-04-02T10:00:00.000Z" });

    const msg = makeMsg({ from: "client@example.com" });
    const match = matchThread(msg, [older, newer]);
    expect(match!.deal.id).toBe(newer.deal.id);
  });

  it("returns null for message replying to a closed deal", () => {
    const ad = makeActiveDeal({ clientContact: "client@example.com" });
    ad.deal.stage = "closed";
    const originalMsg = makeMsg({ id: "msg_in_closed_deal" });
    addMessageToConversation(ad.conversation, originalMsg);

    const reply = makeMsg({ responseToId: "msg_in_closed_deal" });
    expect(matchThread(reply, [ad])).toBeNull();
  });

  it("matches by threadId", () => {
    const ad = makeActiveDeal();
    const threadMsg = makeMsg({ threadId: "thread_abc" });
    addMessageToConversation(ad.conversation, threadMsg);

    const newMsg = makeMsg({ from: "someone-else@test.com", threadId: "thread_abc" });
    const match = matchThread(newMsg, [ad]);
    expect(match).not.toBeNull();
  });

  it("skips terminal deals for contact matching", () => {
    const closed = makeActiveDeal({ clientContact: "client@example.com" });
    closed.deal.stage = "closed";

    const active = makeActiveDeal({ clientContact: "client@example.com" });

    const msg = makeMsg({ from: "client@example.com" });
    const match = matchThread(msg, [closed, active]);
    expect(match!.deal.id).toBe(active.deal.id);
  });
});

// ── Intent Classifier ────────────────────────────────────────────────────

describe("intent classifier", () => {
  it("classifies operator quote response", () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "sourced" });
    const msg = makeMsg({ from: "+1-555-0100", body: "We can do this trip for $28,000 all-in" });
    expect(classifySender(msg, deal)).toBe("operator");
    expect(classifyIntent(msg, deal, "operator")).toBe("quote_response");
  });

  it("classifies client confirmation", () => {
    const deal = makeDeal({ stage: "presented" });
    const msg = makeMsg({ body: "Sounds good, let's do it!" });
    expect(classifyIntent(msg, deal, "client")).toBe("confirmation");
  });

  it("classifies client decline", () => {
    const deal = makeDeal({ stage: "presented" });
    const msg = makeMsg({ body: "Too expensive, I'll pass" });
    expect(classifyIntent(msg, deal, "client")).toBe("decline");
  });

  it("classifies negotiation", () => {
    const deal = makeDeal({ stage: "presented" });
    const msg = makeMsg({ body: "Can you do a lower price? What about a discount?" });
    expect(classifyIntent(msg, deal, "client")).toBe("negotiation");
  });

  it("classifies info request with question mark", () => {
    const deal = makeDeal();
    const msg = makeMsg({ body: "What's the baggage limit?" });
    expect(classifyIntent(msg, deal, "client")).toBe("info_request");
  });

  it("classifies quote request from new client", () => {
    const deal = makeDeal();
    const msg = makeMsg({ body: "I need to charter a flight from Chicago to Miami" });
    expect(classifyIntent(msg, deal, "client")).toBe("quote_request");
  });

  it("identifies sender as client by email", () => {
    const deal = makeDeal({ clientContact: "sarah@chen.com" });
    const msg = makeMsg({ from: "sarah@chen.com" });
    expect(classifySender(msg, deal)).toBe("client");
  });

  it("identifies sender as operator by phone", () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100" });
    const msg = makeMsg({ from: "+1-555-0100" });
    expect(classifySender(msg, deal)).toBe("operator");
  });

  it("returns unknown for unrecognized sender", () => {
    const deal = makeDeal();
    const msg = makeMsg({ from: "stranger@unknown.com" });
    expect(classifySender(msg, deal)).toBe("unknown");
  });

  it("classifies follow-up when replying to existing conversation", () => {
    const deal = makeDeal({ stage: "estimated" });
    const msg = makeMsg({ body: "Also, we'll need catering", responseToId: "msg_prev" });
    expect(classifyIntent(msg, deal, "client")).toBe("follow_up");
  });
});

// ── Message Router ───────────────────────────────────────────────────────

describe("message router", () => {
  it("creates new deal for unknown sender", async () => {
    const msg = makeMsg({ from: "brand-new@client.com", body: "Need a jet from NY to Miami" });
    const result = await routeMessage(msg, [], { createDeal: defaultCreateDeal });

    expect(result.isNewDeal).toBe(true);
    expect(result.deal).toBeDefined();
    expect(msg.dealId).toBe(result.deal.id);
  });

  it("routes to existing deal for known contact", async () => {
    const ad = makeActiveDeal({ clientContact: "sarah@chen.com" });
    const msg = makeMsg({ from: "sarah@chen.com", body: "Any update on my quote?" });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.isNewDeal).toBe(false);
    expect(result.deal.id).toBe(ad.deal.id);
    expect(result.conversation.touchpointCount).toBe(1);
  });

  it("appends message to conversation", async () => {
    const ad = makeActiveDeal({ clientContact: "sarah@chen.com" });
    const msg1 = makeMsg({ from: "sarah@chen.com", body: "First message" });
    const msg2 = makeMsg({ from: "sarah@chen.com", body: "Second message" });

    await routeMessage(msg1, [ad], { createDeal: defaultCreateDeal });
    await routeMessage(msg2, [ad], { createDeal: defaultCreateDeal });

    expect(ad.conversation.touchpointCount).toBe(2);
  });

  it("re-runs extractors and captures pax update in follow-up", async () => {
    const ad = makeActiveDeal({ clientContact: "client@example.com" });
    ad.deal.trip.pax = 4;

    const msg = makeMsg({
      from: "client@example.com",
      body: "Actually there will be 6 passengers, not 4",
    });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.updatedFields).toContain("pax");
    expect(result.deal.trip.pax).toBe(6);
  });

  it("re-runs extractors and captures budget in follow-up", async () => {
    const ad = makeActiveDeal({ clientContact: "client@example.com" });
    ad.deal.client.budget = null;

    const msg = makeMsg({
      from: "client@example.com",
      body: "Our budget is around $30,000",
    });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.updatedFields).toContain("budget");
    expect(result.deal.client.budget).not.toBeNull();
  });

  it("returns advance_to_quoted for operator quote response", async () => {
    const ad = makeActiveDeal({
      clientContact: "client@example.com",
      operatorPhone: "+1-555-0100",
      operatorName: "Elite Aviation",
      stage: "sourced",
    });
    const msg = makeMsg({
      from: "+1-555-0100",
      body: "We can do this trip for $28,000 all-in",
    });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.intent).toBe("quote_response");
    expect(result.action.type).toBe("advance_to_quoted");
    if (result.action.type === "advance_to_quoted") {
      expect(result.action.operatorPrice).toBe(28000);
    }
  });

  it("returns close_deal for client confirmation on presented deal", async () => {
    const ad = makeActiveDeal({
      clientContact: "client@example.com",
      stage: "presented",
      operatorPhone: "+1-555-0100",
    });
    const msg = makeMsg({
      from: "client@example.com",
      body: "Sounds good, let's do it!",
    });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.intent).toBe("confirmation");
    expect(result.action.type).toBe("close_deal");
    if (result.action.type === "close_deal") {
      expect(result.action.result).toBe("closed");
    }
  });

  it("returns activate_backup for operator decline", async () => {
    const ad = makeActiveDeal({
      clientContact: "client@example.com",
      operatorPhone: "+1-555-0100",
      stage: "sourced",
    });
    const msg = makeMsg({
      from: "+1-555-0100",
      body: "Sorry, that aircraft is not available on that date",
    });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.intent).toBe("decline");
    expect(result.senderRole).toBe("operator");
    expect(result.action.type).toBe("activate_backup");
  });

  it("flags negotiation for human handling", async () => {
    const ad = makeActiveDeal({
      clientContact: "client@example.com",
      stage: "presented",
    });
    const msg = makeMsg({
      from: "client@example.com",
      body: "Can you do a lower price? What about a discount?",
    });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.intent).toBe("negotiation");
    expect(result.action.type).toBe("flag_for_human");
  });

  it("creates new deal for message matching closed deal by contact", async () => {
    const closed = makeActiveDeal({ clientContact: "client@example.com" });
    closed.deal.stage = "closed";

    const msg = makeMsg({ from: "client@example.com", body: "I need another flight" });
    const result = await routeMessage(msg, [closed], { createDeal: defaultCreateDeal });

    expect(result.isNewDeal).toBe(true);
  });

  it("extracts $Xk price format from operator", async () => {
    const ad = makeActiveDeal({
      clientContact: "client@example.com",
      operatorPhone: "+1-555-0100",
      stage: "sourced",
    });
    const msg = makeMsg({ from: "+1-555-0100", body: "Best I can do is $32k for this route" });

    const result = await routeMessage(msg, [ad], { createDeal: defaultCreateDeal });

    expect(result.action.type).toBe("advance_to_quoted");
    if (result.action.type === "advance_to_quoted") {
      expect(result.action.operatorPrice).toBe(32000);
    }
  });
});
