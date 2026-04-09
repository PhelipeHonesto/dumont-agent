/**
 * Integration tests — full deal lifecycle through the communication layer.
 * Per spec: communication-layer.md Sprint 7.
 * These tests wire real modules together — no re-implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EmailAdapter } from "../../src/channels/email.js";
import { BlandAiAdapter } from "../../src/channels/bland-ai.js";
import { WebFormAdapter } from "../../src/channels/web-form.js";
import { VoiceCopilotAdapter } from "../../src/channels/voice.js";
import { ResendClient } from "../../src/integrations/resend.js";
import type { ResendInboundWebhook } from "../../src/integrations/resend.js";
import { BlandAiClient } from "../../src/integrations/bland-ai.js";
import type { BlandVoiceWebhook, BlandSmsWebhook } from "../../src/integrations/bland-ai.js";
import { routeMessage } from "../../src/router/message-router.js";
import type { ActiveDeal } from "../../src/router/thread-matcher.js";
import { evaluateConfidence } from "../../src/router/confidence-gate.js";
import { classifyLead } from "../../src/capabilities/sdr.js";
import { respond } from "../../src/capabilities/respond.js";
import { evaluateDraft } from "../../src/capabilities/draft-evaluator.js";
import { processChunk, extractAllEntities, generateSummary } from "../../src/capabilities/transcript-processor.js";
import { regressStage } from "../../src/orchestrator/stage-transitions.js";
import { closeDeal } from "../../src/orchestrator/index.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../../src/orchestrator/deal-context-manager.js";
import { advanceStage } from "../../src/orchestrator/stage-transitions.js";
import { createConversation, addMessageToConversation } from "../../src/schemas/conversation.js";
import { MessageStore } from "../../src/memory/message-store.js";
import { DealStore } from "../../src/memory/deal-store.js";
import { AutonomyStore } from "../../src/memory/autonomy-store.js";
import { CallStore } from "../../src/memory/call-store.js";
import type { Message } from "../../src/schemas/message.js";
import { generateMessageId } from "../../src/schemas/message.js";
import type { DealContext } from "../../src/schemas/deal-context.js";
import type { TranscriptChunk, Call } from "../../src/schemas/call.js";
import { createTestDb } from "../../src/memory/database.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(() => _resetDealCounter());

// ── Fixture helpers ──────────────────────────────────────────────────────

function tmpJsonStore<T>(Ctor: new (path: string) => T): { store: T; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dumont-e2e-"));
  const path = join(dir, "store.json");
  writeFileSync(path, "[]");
  return { store: new Ctor(path), cleanup: () => rmSync(dir, { recursive: true }) };
}

function tmpDealStore(): { store: DealStore; cleanup: () => void } {
  const db = createTestDb();
  return { store: new DealStore(db), cleanup: () => db.close() };
}

const mockFetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "mock_001", message_id: "mock_001", sid: "mock_sid" }) });

function makeDealAtStage(stage: string, overrides?: Partial<Pick<DealContext, "client" | "trip" | "estimate" | "sourcing" | "quote" | "presentation">>): DealContext {
  const deal = createDealContext("live");
  updateDealContext(deal, {
    client: { name: "Sarah Chen", contact: "sarah@chen.com", type: "new", budget: { min: 25000, max: 40000 }, substitutionPref: null, qualified: true, qualificationReason: "test" },
    trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: "light", aircraftType: null, isRoundTrip: false, specialRequirements: [] },
    estimate: { source: "aviapages", flightTime: 150, priceRange: { low: 25000, high: 35000 }, fuelBurn: 280, positioning: null, calculatedAt: new Date().toISOString() },
    sourcing: { selectedOperator: { operatorId: "op_001", operatorName: "Elite Aviation", phone: "op@elite.com", baseAirport: "KTEB", aircraftType: "Phenom 300E", aircraftTail: "N300EA", score: 0.85, scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 }, distanceToDeparture: 0 }, backupOperator: null, rankingReason: "test", laneHistory: [] },
    quote: { operatorPrice: 28000, osaPrice: 30435, margin: 0.08, validUntil: new Date(Date.now() + 7200000).toISOString(), aircraft: { type: "Phenom 300E", tail: "N300EA", year: 2022 }, quotedAt: new Date().toISOString() },
    presentation: { sentAt: new Date().toISOString(), viewedAt: null, clientDecision: "pending", decisionAt: null, timerStarted: new Date().toISOString() },
    ...overrides,
  });
  const path: Record<string, string[]> = {
    qualified: ["qualified"], estimated: ["qualified", "estimated"],
    sourced: ["qualified", "estimated", "sourced"],
    quoted: ["qualified", "estimated", "sourced", "quoted"],
    presented: ["qualified", "estimated", "sourced", "quoted", "presented"],
  };
  for (const s of path[stage] ?? []) advanceStage(deal, s as DealContext["stage"]);
  return deal;
}

function makeActiveDeal(deal: DealContext): ActiveDeal {
  return { deal, conversation: createConversation(deal.id) };
}

// ── Test a: Email inbound → full pipeline → closed ───────────────────────

describe("email inbound → new deal → full pipeline → closed", () => {
  it("processes complete deal lifecycle through email channel", async () => {
    const resend = new ResendClient({ apiKey: "test" }, mockFetch);
    const emailAdapter = new EmailAdapter(resend);
    const { store: dealStore, cleanup: cleanupDeals } = tmpDealStore();
    const { store: msgStore, cleanup: cleanupMsgs } = tmpJsonStore(MessageStore);

    // 1. Inbound email arrives
    const webhook: ResendInboundWebhook = {
      type: "email.received",
      data: {
        id: "resend_in_001", from: "sarah@chen.com", from_name: "Sarah Chen",
        to: ["charter@osa.aero"], subject: "Charter request",
        text: "I need a flight from Teterboro to Palm Beach on April 15 for 4 passengers. Budget $30,000.",
        created_at: new Date().toISOString(),
      },
    };
    const inboundMsg = emailAdapter.receive(webhook);
    expect(inboundMsg.channel).toBe("email");
    expect(inboundMsg.from).toBe("sarah@chen.com");

    // 2. Router creates new deal (set client contact for thread matching)
    const routeResult = await routeMessage(inboundMsg, [], {
      createDeal: async () => {
        const d = createDealContext("live");
        updateDealContext(d, { client: { name: "Sarah Chen", contact: "sarah@chen.com", type: "new", budget: null, substitutionPref: null, qualified: true, qualificationReason: "test" } });
        return d;
      },
    });
    expect(routeResult.isNewDeal).toBe(true);
    msgStore.save_message(inboundMsg);

    // 3. Respond drafts operator RFQ
    const rfqDraft = await respond(routeResult.deal, inboundMsg, "quote_request");
    expect(rfqDraft.draft.draftedBy).toBe("dumont");
    msgStore.save_message(rfqDraft.draft);

    // 4. Confidence gate holds (no autonomy store → delayed or hold)
    const gate1 = evaluateConfidence(rfqDraft.draft, routeResult.deal, null);
    expect(["hold", "delayed"]).toContain(gate1.action);

    // 5. Operator replies with price
    const opReply: ResendInboundWebhook = {
      type: "email.received",
      data: {
        id: "resend_in_002", from: "op@elite.com", to: ["charter@osa.aero"],
        subject: "Re: Charter request", text: "We can do $28,000 all-in for the Phenom 300E N300EA.",
        headers: { "In-Reply-To": rfqDraft.draft.id },
        created_at: new Date().toISOString(),
      },
    };
    const opMsg = emailAdapter.receive(opReply);
    const ad = makeActiveDeal(routeResult.deal);
    addMessageToConversation(ad.conversation, inboundMsg);
    addMessageToConversation(ad.conversation, rfqDraft.draft);

    // Simulate deal advanced to sourced so operator routing works
    updateDealContext(routeResult.deal, { sourcing: { selectedOperator: { operatorId: "op_001", operatorName: "Elite Aviation", phone: "op@elite.com", baseAirport: "KTEB", aircraftType: "Phenom 300E", aircraftTail: "N300EA", score: 0.85, scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 }, distanceToDeparture: 0 }, backupOperator: null, rankingReason: "test", laneHistory: [] } });
    advanceStage(routeResult.deal, "qualified");
    advanceStage(routeResult.deal, "estimated");
    advanceStage(routeResult.deal, "sourced");

    const routeResult2 = await routeMessage(opMsg, [ad], { createDeal: async () => createDealContext("live") });
    expect(routeResult2.intent).toBe("quote_response");
    expect(routeResult2.action.type).toBe("advance_to_quoted");
    msgStore.save_message(opMsg);

    // 6. Client confirms
    advanceStage(routeResult.deal, "quoted");
    advanceStage(routeResult.deal, "presented");
    routeResult.deal.presentation.sentAt = new Date().toISOString();
    routeResult.deal.presentation.clientDecision = "pending";

    const confirmMsg: ResendInboundWebhook = {
      type: "email.received",
      data: {
        id: "resend_in_003", from: "sarah@chen.com", to: ["charter@osa.aero"],
        subject: "Re: Your Charter Quote", text: "Sounds great, let's do it!",
        created_at: new Date().toISOString(),
      },
    };
    const clientConfirm = emailAdapter.receive(confirmMsg);
    const routeResult3 = await routeMessage(clientConfirm, [ad], { createDeal: async () => createDealContext("live") });
    expect(routeResult3.intent).toBe("confirmation");
    expect(routeResult3.action.type).toBe("close_deal");

    // 7. Close deal → learning loop
    updateDealContext(routeResult.deal, { quote: { operatorPrice: 28000, osaPrice: 30435, margin: 0.08, validUntil: new Date(Date.now() + 7200000).toISOString(), aircraft: { type: "Phenom 300E", tail: "N300EA", year: 2022 }, quotedAt: new Date().toISOString() } });
    closeDeal(routeResult.deal, { result: "closed", dealStore, operatorResponseTime: 1800 });

    // 8. Verify final state
    expect(routeResult.deal.stage).toBe("closed");
    expect(dealStore.count).toBe(1);
    expect(msgStore.count).toBe(3);

    cleanupDeals(); cleanupMsgs();
  });
});

// ── Test b: Bland AI voice → SDR → text follow-up ──────────────────────

describe("Bland AI voice → SDR qualifies → text follow-up", () => {
  it("processes voice webhook through SDR and responds via text", async () => {
    const blandClient = new BlandAiClient({ apiKey: "test" }, mockFetch);
    const adapter = new BlandAiAdapter(blandClient);

    // 1. Voice webhook with analysis
    const voicePayload: BlandVoiceWebhook = {
      call_id: "call_001", call_type: "voice",
      from: "+1-312-555-0199", to: "+1-773-555-0100",
      status: "completed", started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(), duration: 180,
      transcript: "I need to charter a flight from Teterboro to Palm Beach on April 15 for 4 passengers. Budget around $30,000.",
      summary: "TEB to PBI, April 15, 4 pax, ~$30K.",
      analysis: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, budget_min: 25000, budget_max: 35000, client_name: "Sarah Chen", client_phone: "+1-312-555-0199" },
    };
    const voiceMsg = adapter.receive(voicePayload);
    expect(voiceMsg.channel).toBe("bland_voice");

    // 2. SDR classifies (use transcript body which has parseable fields)
    const sdr = classifyLead(voicePayload.transcript, null, new Date(2026, 2, 31));
    expect(sdr.classification).toBe("qualified_with_budget");

    // 3. Router creates deal
    const routeResult = await routeMessage(voiceMsg, [], { createDeal: async () => createDealContext("live") });
    expect(routeResult.isNewDeal).toBe(true);
    expect(voiceMsg.parsedData?.["departure"]).toBe("KTEB");

    // 4. Respond drafts acknowledgment
    const ackDraft = await respond(routeResult.deal, voiceMsg, "follow_up");
    expect(ackDraft.draft.draftedBy).toBe("dumont");
    expect(ackDraft.confidenceLevel).toBe("high");
  });
});

// ── Test c: Cross-channel threading ──────────────────────────────────────

describe("web form → email → SMS cross-channel threading", () => {
  it("maintains single deal across web form and SMS channels", async () => {
    const webAdapter = new WebFormAdapter();
    const blandClient = new BlandAiClient({ apiKey: "test" }, mockFetch);
    const blandAdapter = new BlandAiAdapter(blandClient);

    // 1. Web form arrives
    const formMsg = webAdapter.receive({
      name: "Sarah Chen", email: "sarah@chen.com", phone: "+1-312-555-0199",
      departure: "Teterboro", arrival: "Palm Beach", date: "2026-04-15", pax: 4,
    });
    expect(formMsg.channel).toBe("web_form");

    const routeResult = await routeMessage(formMsg, [], { createDeal: async () => {
      const deal = createDealContext("live");
      updateDealContext(deal, { client: { name: "Sarah Chen", contact: "+1-312-555-0199", type: "new", budget: null, substitutionPref: null, qualified: true, qualificationReason: "test" }, trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: null, aircraftType: null, isRoundTrip: false, specialRequirements: [] } });
      return deal;
    } });
    expect(routeResult.isNewDeal).toBe(true);
    expect(routeResult.deal.client.budget).toBeNull();

    // 2. Client texts budget from same phone
    const smsPayload: BlandSmsWebhook = {
      message_id: "sms_001", message_type: "imessage",
      from: "+1-312-555-0199", to: "+1-773-555-0100",
      body: "Our budget is around $30,000",
      received_at: new Date().toISOString(),
    };
    const smsMsg = blandAdapter.receive(smsPayload);
    const ad = makeActiveDeal(routeResult.deal);
    addMessageToConversation(ad.conversation, formMsg);

    const routeResult2 = await routeMessage(smsMsg, [ad], { createDeal: async () => createDealContext("live") });

    // 3. Verify: same deal, budget updated
    expect(routeResult2.isNewDeal).toBe(false);
    expect(routeResult2.deal.id).toBe(routeResult.deal.id);
    expect(routeResult2.updatedFields).toContain("budget");
    expect(routeResult2.deal.client.budget).not.toBeNull();
    expect(routeResult2.conversation.channelsUsed).toContain("web_form");
    expect(routeResult2.conversation.channelsUsed).toContain("bland_text");
  });
});

// ── Test d: Voice copilot → entity detection ─────────────────────────────

describe("voice copilot → entity detection → deal update", () => {
  it("detects entities from operator call transcript", async () => {
    const chunks: TranscriptChunk[] = [
      { chunkId: "c1", speaker: "counterparty", text: "We have a Phenom 300E available, tail N300EL", timestampMs: 5000, durationMs: 3000, confidence: 0.95, isFinal: true, detectedEntities: [] },
      { chunkId: "c2", speaker: "counterparty", text: "Best I can do is $28,500 all-in from KTEB", timestampMs: 12000, durationMs: 2500, confidence: 0.92, isFinal: true, detectedEntities: [] },
      { chunkId: "c3", speaker: "counterparty", text: "I can hold it for two hours", timestampMs: 18000, durationMs: 1500, confidence: 0.90, isFinal: true, detectedEntities: [] },
    ];

    // Per-chunk detection
    const chunk1Entities = processChunk(chunks[0]!);
    expect(chunk1Entities.some((e) => e.type === "aircraft_type")).toBe(true);
    expect(chunk1Entities.some((e) => e.type === "tail_number" && e.value === "N300EL")).toBe(true);

    const chunk2Entities = processChunk(chunks[1]!);
    expect(chunk2Entities.some((e) => e.type === "price")).toBe(true);
    expect(chunk2Entities.some((e) => e.type === "negotiation_signal" && e.value === "firm")).toBe(true);

    // Post-call batch extraction
    const allEntities = extractAllEntities(chunks);
    const types = allEntities.map((e) => e.type);
    expect(types).toContain("aircraft_type");
    expect(types).toContain("tail_number");
    expect(types).toContain("price");
    expect(types).toContain("airport");
    expect(types).toContain("hold_duration");

    // Summary
    const summary = await generateSummary(chunks, allEntities);
    expect(summary.length).toBeGreaterThan(0);

    // Call store
    const { store: callStore, cleanup } = tmpJsonStore(CallStore);
    const call: Call = {
      callId: "call_e2e", dealId: "deal_001", direction: "outbound_to_operator",
      participants: [{ name: "Phelipe", role: "broker", phone: "+1-773-555-0100" }, { name: "John", role: "operator", phone: "+1-555-0200" }],
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      durationSec: 25, transcript: chunks, detectedEntities: allEntities,
      summary, recordingUrl: null, recordingExpiresAt: null,
    };
    callStore.saveCall(call);
    expect(callStore.getByDealId("deal_001")).toHaveLength(1);

    // Voice adapter creates message
    const voiceAdapter = new VoiceCopilotAdapter();
    const msg = voiceAdapter.receive(call);
    expect(msg.channel).toBe("voice_copilot");
    expect(msg.body).toContain(summary);

    cleanup();
  });
});

// ── Test e: Stage regression through comms layer ─────────────────────────

describe("stage regression through comms layer", () => {
  it("regresses presented → estimated when client wants cheaper aircraft", async () => {
    const deal = makeDealAtStage("presented");
    const ad = makeActiveDeal(deal);

    // Client replies wanting cheaper option
    const resend = new ResendClient({ apiKey: "test" }, mockFetch);
    const emailAdapter = new EmailAdapter(resend);
    const clientMsg = emailAdapter.receive({
      type: "email.received",
      data: {
        id: "resend_neg_001", from: "sarah@chen.com", to: ["charter@osa.aero"],
        subject: "Re: Your Charter Quote",
        text: "Can you do a lower price? What about a lighter jet? I'd like to negotiate.",
        created_at: new Date().toISOString(),
      },
    } satisfies ResendInboundWebhook);

    addMessageToConversation(ad.conversation, clientMsg);
    const routeResult = await routeMessage(clientMsg, [ad], { createDeal: async () => createDealContext("live") });

    expect(routeResult.intent).toBe("negotiation");
    expect(routeResult.action.type).toBe("flag_for_human");

    // Human triggers regression
    regressStage(deal, "estimated", "Client wants a lighter jet");

    // Verify data clearing
    expect(deal.stage).toBe("estimated");
    expect(deal.sourcing.selectedOperator).toBeNull();
    expect(deal.quote.operatorPrice).toBeNull();
    expect(deal.presentation.sentAt).toBeNull();
    // Preserved
    expect(deal.client.name).toBe("Sarah Chen");
    expect(deal.trip.departure).toBe("KTEB");
    expect(deal.estimate.priceRange).not.toBeNull();
    // History
    const regressions = deal.stageHistory.filter((h) => h.stage.startsWith("regression:"));
    expect(regressions).toHaveLength(1);
    expect(regressions[0]!.stage).toContain("presented");
    expect(regressions[0]!.stage).toContain("estimated");
  });
});

// ── Test f: Autonomy graduation lifecycle ────────────────────────────────

describe("autonomy graduation lifecycle", () => {
  it("graduates after 10 zero-edit approvals, revokes on edit", async () => {
    const { store: autoStore, cleanup } = tmpJsonStore(AutonomyStore);

    // Approve 10 follow-ups with 0 edits
    for (let i = 0; i < 10; i++) {
      const graduated = autoStore.recordApproval("email", "follow_up", "client", 0);
      if (i < 9) expect(graduated).toBe(false);
      else expect(graduated).toBe(true);
    }
    expect(autoStore.isAutonomous("email", "follow_up", "client")).toBe(true);

    // 11th draft should auto-send
    const deal = makeDealAtStage("presented");
    const msg: Message = {
      id: generateMessageId(), dealId: deal.id, channel: "email", direction: "outbound",
      from: "charter@osa.aero", to: "sarah@chen.com", fromName: null, subject: "Follow up",
      body: "Any update?", bodyHtml: null, attachments: [],
      draftedBy: "dumont", approvedBy: null, editDistance: null, originalDraft: "Any update?",
      receivedAt: null, draftedAt: new Date().toISOString(), approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null,
      intent: "follow_up", parsedData: null, confidence: 0.8, confidenceLevel: "high",
      platformMessageId: null, platformMetadata: null,
    };
    const gate = evaluateConfidence(msg, deal, autoStore);
    expect(gate.action).toBe("auto_send");

    // Edit revokes autonomy
    autoStore.recordApproval("email", "follow_up", "client", 5);
    expect(autoStore.isAutonomous("email", "follow_up", "client")).toBe(false);
    expect(autoStore.getRule("email", "follow_up", "client").currentApprovals).toBe(0);

    // Next draft holds
    const gate2 = evaluateConfidence(msg, deal, autoStore);
    expect(gate2.action).not.toBe("auto_send");

    cleanup();
  });
});

// ── Test g: Draft evaluator catches bad draft ────────────────────────────

describe("draft evaluator catches bad draft in pipeline", () => {
  it("catches WiFi claim and revises", async () => {
    const deal = makeDealAtStage("quoted");

    const draftMsg: Message = {
      id: generateMessageId(), dealId: deal.id, channel: "email", direction: "outbound",
      from: "charter@osa.aero", to: "sarah@chen.com", fromName: null, subject: "Your quote",
      body: "Your Phenom 300E has WiFi and a fully stocked galley. All-in price: $30,435.",
      bodyHtml: null, attachments: [],
      draftedBy: "dumont", approvedBy: null, editDistance: null, originalDraft: null,
      receivedAt: null, draftedAt: new Date().toISOString(), approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null,
      intent: "quote_response", parsedData: null, confidence: 0.5, confidenceLevel: "low",
      platformMessageId: null, platformMetadata: null,
    };

    // Code-based evaluator catches WiFi
    const result = await evaluateDraft(draftMsg, deal);
    expect(result.issues.some((i) => i.includes("WiFi"))).toBe(true);

    // With reviser: revised draft removes WiFi
    const resultWithReviser = await evaluateDraft(draftMsg, deal, {
      reviser: async (original, issues) => {
        let revised = original;
        if (issues.some((i) => i.includes("WiFi"))) {
          revised = revised.replace(/has WiFi and a fully stocked galley/, "is configured for your trip");
        }
        return revised;
      },
    });
    expect(resultWithReviser.wasRevised).toBe(true);
    expect(resultWithReviser.draft).not.toContain("WiFi");
    expect(resultWithReviser.originalBeforeRevision).toContain("WiFi");
  });
});
