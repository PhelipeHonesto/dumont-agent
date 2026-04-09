/**
 * Integration tests — error paths and failure modes.
 * Per spec: communication-layer.md Sprint 7.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BlandAiClient } from "../../src/integrations/bland-ai.js";
import { BlandAiAdapter } from "../../src/channels/bland-ai.js";
import { ResendClient } from "../../src/integrations/resend.js";
import { EmailAdapter } from "../../src/channels/email.js";
import { routeMessage } from "../../src/router/message-router.js";
import type { ActiveDeal } from "../../src/router/thread-matcher.js";
import { matchThread } from "../../src/router/thread-matcher.js";
import { evaluateConfidence } from "../../src/router/confidence-gate.js";
import { respond } from "../../src/capabilities/respond.js";
import { regressStage } from "../../src/orchestrator/stage-transitions.js";
import { PipelineError } from "../../src/utils/errors.js";
import { AutonomyStore } from "../../src/memory/autonomy-store.js";
import { MessageStore } from "../../src/memory/message-store.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../../src/orchestrator/deal-context-manager.js";
import { advanceStage } from "../../src/orchestrator/stage-transitions.js";
import { createConversation, addMessageToConversation } from "../../src/schemas/conversation.js";
import { generateMessageId } from "../../src/schemas/message.js";
import type { Message, MessageChannel } from "../../src/schemas/message.js";
import type { DealContext } from "../../src/schemas/deal-context.js";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(() => _resetDealCounter());

const mockFetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "m1" }) });

function tmpStore<T>(Ctor: new (path: string) => T): { store: T; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dumont-err-"));
  const path = join(dir, "s.json");
  writeFileSync(path, "[]");
  return { store: new Ctor(path), cleanup: () => rmSync(dir, { recursive: true }) };
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: generateMessageId(), dealId: null, channel: "email" as MessageChannel, direction: "inbound",
    from: "test@test.com", to: "charter@osa.aero", fromName: null, subject: null,
    body: "Test message", bodyHtml: null, attachments: [],
    draftedBy: null, approvedBy: null, editDistance: null, originalDraft: null,
    receivedAt: new Date().toISOString(), draftedAt: null, approvedAt: null, sentAt: null,
    responseToId: null, responseTimeMs: null, threadId: null,
    intent: null, parsedData: null, confidence: null, confidenceLevel: null,
    platformMessageId: null, platformMetadata: null, ...overrides,
  };
}

function makeDeal(stage?: string): DealContext {
  const deal = createDealContext("live");
  updateDealContext(deal, {
    client: { name: "Test", contact: "test@test.com", type: "new", budget: { min: 25000, max: 40000 }, substitutionPref: null, qualified: true, qualificationReason: "test" },
    trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: "light", aircraftType: null, isRoundTrip: false, specialRequirements: [] },
    estimate: { source: "aviapages", flightTime: 150, priceRange: { low: 25000, high: 35000 }, fuelBurn: 280, positioning: null, calculatedAt: new Date().toISOString() },
    sourcing: { selectedOperator: { operatorId: "op_001", operatorName: "Elite", phone: "op@test.com", baseAirport: "KTEB", aircraftType: "Phenom 300E", aircraftTail: null, score: 0.85, scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 }, distanceToDeparture: 0 }, backupOperator: null, rankingReason: "t", laneHistory: [] },
    quote: { operatorPrice: 28000, osaPrice: 30435, margin: 0.08, validUntil: new Date(Date.now() + 7200000).toISOString(), aircraft: null, quotedAt: new Date().toISOString() },
    presentation: { sentAt: new Date().toISOString(), viewedAt: null, clientDecision: "pending", decisionAt: null, timerStarted: new Date().toISOString() },
  });
  const path: Record<string, string[]> = {
    qualified: ["qualified"], estimated: ["qualified", "estimated"],
    sourced: ["qualified", "estimated", "sourced"],
    quoted: ["qualified", "estimated", "sourced", "quoted"],
    presented: ["qualified", "estimated", "sourced", "quoted", "presented"],
    confirmed: ["qualified", "estimated", "sourced", "quoted", "presented", "confirmed"],
    closed: ["qualified", "estimated", "sourced", "quoted", "presented", "confirmed", "closed"],
  };
  for (const s of path[stage ?? "presented"] ?? []) advanceStage(deal, s as DealContext["stage"]);
  return deal;
}

// ── Error Path Tests ─────────────────────────────────────────────────────

describe("webhook signature rejection", () => {
  it("Bland AI rejects invalid signature", () => {
    const client = new BlandAiClient({ apiKey: "test", webhookSecret: "secret123" });
    const valid = client.verifyWebhook('{"test":true}', createHmac("sha256", "secret123").update('{"test":true}').digest("hex"));
    expect(valid).toBe(true);
    expect(client.verifyWebhook('{"test":true}', "wrong_sig")).toBe(false);
  });

  it("Resend rejects invalid signature", () => {
    const client = new ResendClient({ apiKey: "test", webhookSecret: "resend_secret" });
    expect(client.verifyWebhook('{"data":"x"}', "invalid")).toBe(false);
  });
});

describe("router handles edge cases", () => {
  it("handles malformed message body gracefully", async () => {
    const msg = makeMsg({ body: "" });
    const result = await routeMessage(msg, [], { createDeal: async () => createDealContext("live") });
    expect(result.isNewDeal).toBe(true);
    expect(result.deal).toBeDefined();
  });

  it("thread matcher returns most recent deal on ambiguous match", () => {
    const deal1 = makeDeal("estimated");
    deal1.updatedAt = "2026-04-01T10:00:00.000Z";
    const deal2 = makeDeal("sourced");
    deal2.updatedAt = "2026-04-02T10:00:00.000Z";

    const ad1: ActiveDeal = { deal: deal1, conversation: createConversation(deal1.id) };
    const ad2: ActiveDeal = { deal: deal2, conversation: createConversation(deal2.id) };

    const msg = makeMsg({ from: "test@test.com" });
    const match = matchThread(msg, [ad1, ad2]);
    expect(match).not.toBeNull();
    expect(match!.deal.id).toBe(deal2.id); // most recent wins
  });
});

describe("respond handles failure gracefully", () => {
  it("uses template fallback when no LLM provided", async () => {
    const deal = makeDeal("sourced");
    const inbound = makeMsg({ body: "Need a quote" });
    const result = await respond(deal, inbound, "follow_up");
    expect(result.draft.body.length).toBeGreaterThan(0);
    expect(result.draft.draftedBy).toBe("dumont");
  });
});

describe("confidence gate blocks on NEVER list even if autonomous", () => {
  it("blocks client-facing price even with autonomy earned", () => {
    const { store: autoStore, cleanup } = tmpStore(AutonomyStore);
    // Graduate autonomy
    for (let i = 0; i < 10; i++) autoStore.recordApproval("email", "quote_response", "client", 0);
    expect(autoStore.isAutonomous("email", "quote_response", "client")).toBe(true);

    const deal = makeDeal("presented");
    const msg = makeMsg({
      direction: "outbound", to: "test@test.com", body: "Your price is $30,435.",
      intent: "quote_response", confidenceLevel: "high",
      draftedBy: "dumont", channel: "email",
    });
    const gate = evaluateConfidence(msg, deal, autoStore);
    expect(gate.action).toBe("blocked"); // price to client = NEVER
    cleanup();
  });
});

describe("stage regression from closed throws PipelineError", () => {
  it("throws when regressing from closed", () => {
    const deal = makeDeal("closed");
    expect(() => regressStage(deal, "estimated", "test")).toThrow(PipelineError);
  });

  it("throws when regressing from failed", () => {
    const deal = createDealContext("live");
    advanceStage(deal, "failed");
    expect(() => regressStage(deal, "estimated", "test")).toThrow(PipelineError);
  });
});

describe("MessageStore persists through save/load cycle", () => {
  it("messages survive store recreation", () => {
    const dir = mkdtempSync(join(tmpdir(), "dumont-persist-"));
    const path = join(dir, "msgs.json");
    writeFileSync(path, "[]");

    // Save
    const store1 = new MessageStore(path);
    store1.saveMessage(makeMsg({ id: "persist_001", body: "Persisted message" }));
    expect(store1.count).toBe(1);

    // Recreate from same file
    const store2 = new MessageStore(path);
    expect(store2.count).toBe(1);
    expect(store2.getByMessageId("persist_001")).not.toBeNull();
    expect(store2.getByMessageId("persist_001")!.body).toBe("Persisted message");

    rmSync(dir, { recursive: true });
  });
});
