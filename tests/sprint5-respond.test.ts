/**
 * Tests for Sprint 5: Respond + Draft Evaluator + Edit Memory + SDR + Confidence Gate.
 * Per spec: communication-layer.md Sprint 5, FR-4, FR-6, FR-9, FR-10.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getEditHistory, buildEditMemoryPromptSection } from "../src/memory/edit-memory.js";
import { AutonomyStore } from "../src/memory/autonomy-store.js";
import { evaluateConfidence, getRecipientType } from "../src/router/confidence-gate.js";
import { classifyLead } from "../src/capabilities/sdr.js";
import { evaluateDraft, summarizeDealForEval } from "../src/capabilities/draft-evaluator.js";
import { respond, buildRespondSystemPrompt } from "../src/capabilities/respond.js";
import { MessageStore } from "../src/memory/message-store.js";
import type { Message } from "../src/schemas/message.js";
import { generateMessageId } from "../src/schemas/message.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import { advanceStage } from "../src/orchestrator/stage-transitions.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(() => _resetDealCounter());

// ── Helpers ──────────────────────────────────────────────────────────────

function makeStore(): { msgStore: MessageStore; autoStore: AutonomyStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dumont-s5-"));
  const msgPath = join(dir, "messages.json");
  const autoPath = join(dir, "autonomy.json");
  writeFileSync(msgPath, "[]");
  writeFileSync(autoPath, "[]");
  return { msgStore: new MessageStore(msgPath), autoStore: new AutonomyStore(autoPath), cleanup: () => rmSync(dir, { recursive: true }) };
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: generateMessageId(), dealId: "deal_001", channel: "email", direction: "outbound",
    from: "charter@osa.aero", to: "client@test.com", fromName: null, subject: null,
    body: "Your quote is ready.", bodyHtml: null, attachments: [],
    draftedBy: "dumont", approvedBy: null, editDistance: null, originalDraft: "Your quote is ready.",
    receivedAt: null, draftedAt: new Date().toISOString(), approvedAt: null,
    sentAt: new Date().toISOString(), responseToId: null, responseTimeMs: null, threadId: null,
    intent: "follow_up", parsedData: null, confidence: 0.8, confidenceLevel: "high",
    platformMessageId: null, platformMetadata: null, ...overrides,
  };
}

function makeDeal(opts?: { stage?: string; operatorPhone?: string }) {
  const deal = createDealContext("live");
  updateDealContext(deal, {
    client: { name: "Sarah", contact: "sarah@chen.com", type: "new", budget: { min: 25000, max: 40000 }, substitutionPref: null, qualified: true, qualificationReason: "test" },
    trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: "light", aircraftType: null, isRoundTrip: false, specialRequirements: [] },
    estimate: { source: "aviapages", flightTime: 150, priceRange: { low: 25000, high: 35000 }, fuelBurn: 280, positioning: null, calculatedAt: new Date().toISOString() },
  });
  if (opts?.operatorPhone) {
    updateDealContext(deal, {
      sourcing: { selectedOperator: { operatorId: "op_001", operatorName: "Elite Aviation", phone: opts.operatorPhone, baseAirport: "KTEB", aircraftType: "Phenom 300E", aircraftTail: null, score: 0.85, scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 }, distanceToDeparture: 0 }, backupOperator: null, rankingReason: "test", laneHistory: [] },
      quote: { operatorPrice: 28000, osaPrice: 30435, margin: 0.08, validUntil: new Date(Date.now() + 7200000).toISOString(), aircraft: null, quotedAt: new Date().toISOString() },
    });
  }
  if (opts?.stage) {
    const path: Record<string, string[]> = { qualified: ["qualified"], estimated: ["qualified", "estimated"], sourced: ["qualified", "estimated", "sourced"], quoted: ["qualified", "estimated", "sourced", "quoted"], presented: ["qualified", "estimated", "sourced", "quoted", "presented"] };
    for (const s of path[opts.stage] ?? []) advanceStage(deal, s as any);
  }
  return deal;
}

// ── Edit Memory ──────────────────────────────────────────────────────────

describe("edit memory", () => {
  it("returns empty array on cold start", () => {
    const { msgStore, cleanup } = makeStore();
    const history = getEditHistory(msgStore, "follow_up", "email");
    expect(history).toHaveLength(0);
    cleanup();
  });

  it("returns edited drafts sorted by recency", () => {
    const { msgStore, cleanup } = makeStore();
    msgStore.save_message(makeMsg({ intent: "follow_up", editDistance: 3, originalDraft: "Draft v1", body: "Edited v1", sentAt: "2026-04-01T10:00:00.000Z" }));
    msgStore.save_message(makeMsg({ intent: "follow_up", editDistance: 2, originalDraft: "Draft v2", body: "Edited v2", sentAt: "2026-04-02T10:00:00.000Z" }));

    const history = getEditHistory(msgStore, "follow_up", "email");
    expect(history).toHaveLength(2);
    expect(history[0]!.dumontWrote).toBe("Draft v2"); // more recent first
    expect(history[0]!.brokerChangedTo).toBe("Edited v2");
    cleanup();
  });

  it("filters by intent + channel", () => {
    const { msgStore, cleanup } = makeStore();
    msgStore.save_message(makeMsg({ intent: "follow_up", channel: "email", editDistance: 1, originalDraft: "A", body: "B" }));
    msgStore.save_message(makeMsg({ intent: "quote_request", channel: "email", editDistance: 1, originalDraft: "C", body: "D" }));
    msgStore.save_message(makeMsg({ intent: "follow_up", channel: "bland_text", editDistance: 1, originalDraft: "E", body: "F" }));

    expect(getEditHistory(msgStore, "follow_up", "email")).toHaveLength(1);
    expect(getEditHistory(msgStore, "quote_request", "email")).toHaveLength(1);
    expect(getEditHistory(msgStore, "follow_up", "bland_text")).toHaveLength(1);
    cleanup();
  });

  it("caps at limit (default 10)", () => {
    const { msgStore, cleanup } = makeStore();
    for (let i = 0; i < 15; i++) {
      msgStore.save_message(makeMsg({ intent: "follow_up", editDistance: 1, originalDraft: `D${i}`, body: `E${i}`, sentAt: new Date(Date.now() + i * 1000).toISOString() }));
    }
    expect(getEditHistory(msgStore, "follow_up", "email")).toHaveLength(10);
    cleanup();
  });

  it("prompt section includes examples when available", () => {
    const { msgStore, cleanup } = makeStore();
    msgStore.save_message(makeMsg({ intent: "follow_up", editDistance: 2, originalDraft: "Dumont wrote this", body: "Broker sent this" }));

    const section = buildEditMemoryPromptSection(msgStore, "follow_up", "email");
    expect(section).toContain("STYLE LEARNING");
    expect(section).toContain("Dumont wrote this");
    expect(section).toContain("Broker sent this");
    cleanup();
  });

  it("prompt section is empty when no history", () => {
    const { msgStore, cleanup } = makeStore();
    expect(buildEditMemoryPromptSection(msgStore, "follow_up", "email")).toBe("");
    cleanup();
  });
});

// ── Autonomy Store ───────────────────────────────────────────────────────

describe("autonomy store", () => {
  it("creates default rule with autoSendEnabled=false", () => {
    const { autoStore, cleanup } = makeStore();
    const rule = autoStore.getRule("email", "follow_up", "client");
    expect(rule.autoSendEnabled).toBe(false);
    expect(rule.currentApprovals).toBe(0);
    expect(rule.autoSendAfter).toBe(10);
    cleanup();
  });

  it("graduates after 10 approvals with 0 edits", () => {
    const { autoStore, cleanup } = makeStore();
    for (let i = 0; i < 9; i++) {
      expect(autoStore.recordApproval("email", "follow_up", "client", 0)).toBe(false);
    }
    // 10th approval triggers graduation
    expect(autoStore.recordApproval("email", "follow_up", "client", 0)).toBe(true);
    expect(autoStore.isAutonomous("email", "follow_up", "client")).toBe(true);
    cleanup();
  });

  it("resets on any edit (editDistance > 0)", () => {
    const { autoStore, cleanup } = makeStore();
    for (let i = 0; i < 8; i++) autoStore.recordApproval("email", "follow_up", "client", 0);
    // Edit resets
    autoStore.recordApproval("email", "follow_up", "client", 3);
    expect(autoStore.getRule("email", "follow_up", "client").currentApprovals).toBe(0);
    expect(autoStore.isAutonomous("email", "follow_up", "client")).toBe(false);
    cleanup();
  });

  it("manual revoke works", () => {
    const { autoStore, cleanup } = makeStore();
    for (let i = 0; i < 10; i++) autoStore.recordApproval("email", "follow_up", "client", 0);
    expect(autoStore.isAutonomous("email", "follow_up", "client")).toBe(true);
    autoStore.revokeAutonomy("email", "follow_up", "client");
    expect(autoStore.isAutonomous("email", "follow_up", "client")).toBe(false);
    cleanup();
  });
});

// ── Confidence Gate ──────────────────────────────────────────────────────

describe("confidence gate", () => {
  it("blocks client-facing messages with dollar amounts", () => {
    const deal = makeDeal();
    const msg = makeMsg({ body: "Your all-in price is $30,435", to: "sarah@chen.com" });
    const decision = evaluateConfidence(msg, deal, null);
    expect(decision.action).toBe("blocked");
  });

  it("blocks negotiation intent", () => {
    const deal = makeDeal();
    const msg = makeMsg({ intent: "negotiation", body: "Counter offer" });
    const decision = evaluateConfidence(msg, deal, null);
    expect(decision.action).toBe("blocked");
  });

  it("blocks first contact with operator", () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "sourced" });
    const msg = makeMsg({ to: "+1-555-0100", body: "Requesting quote", intent: "quote_request" });
    const decision = evaluateConfidence(msg, deal, null);
    expect(decision.action).toBe("blocked");
  });

  it("auto-sends when autonomy earned", () => {
    const { autoStore, cleanup } = makeStore();
    for (let i = 0; i < 10; i++) autoStore.recordApproval("email", "follow_up", "client", 0);

    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "presented" });
    const msg = makeMsg({ intent: "follow_up", body: "Any update?", to: "sarah@chen.com", confidenceLevel: "high" });
    const decision = evaluateConfidence(msg, deal, autoStore);
    expect(decision.action).toBe("auto_send");
    cleanup();
  });

  it("holds with delay for medium confidence", () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "presented" });
    const msg = makeMsg({ intent: "info_request", body: "Here is the info", to: "sarah@chen.com", confidenceLevel: "medium" });
    const decision = evaluateConfidence(msg, deal, null);
    expect(decision.action).toBe("delayed");
  });

  it("holds for approval by default", () => {
    const deal = makeDeal();
    const msg = makeMsg({ body: "General message", intent: "general", confidenceLevel: "low" });
    const decision = evaluateConfidence(msg, deal, null);
    expect(decision.action).toBe("hold");
  });
});

// ── SDR Qualification ────────────────────────────────────────────────────

describe("SDR classification", () => {
  it("qualifies with budget when all fields present", () => {
    const result = classifyLead("I need a flight from Teterboro to Palm Beach on April 15 for 4 passengers. Budget $30,000.", null, new Date(2026, 2, 31));
    expect(result.classification).toBe("qualified_with_budget");
    expect(result.confidence).toBeGreaterThan(0.9);
    expect(result.extractedFields).toContain("departure");
    expect(result.extractedFields).toContain("budget");
  });

  it("qualifies without budget when route+date+pax present", () => {
    const result = classifyLead("Charter from Teterboro to Palm Beach on April 15, 4 passengers.", null, new Date(2026, 2, 31));
    expect(result.classification).toBe("qualified_no_budget");
    expect(result.shouldAutoRespond).toBe(true);
  });

  it("not qualified when missing critical fields", () => {
    const result = classifyLead("I want to fly somewhere nice");
    expect(result.classification).toBe("not_qualified");
    expect(result.reason).toContain("Missing");
  });

  it("budget mismatch when budget below estimate", () => {
    const deal = makeDeal();
    const result = classifyLead("Teterboro to Palm Beach April 15, 4 pax. Budget $10,000.", deal, new Date(2026, 2, 31));
    expect(result.classification).toBe("budget_mismatch");
  });
});

// ── Draft Evaluator ──────────────────────────────────────────────────────

describe("draft evaluator", () => {
  it("passes clean draft unchanged (no LLM)", async () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "quoted" });
    const msg = makeMsg({ body: "Following up on your KTEB to KPBI request." });

    const result = await evaluateDraft(msg, deal);
    expect(result.wasRevised).toBe(false);
    expect(result.issues).toHaveLength(0);
  });

  it("catches unverifiable WiFi claim", async () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "quoted" });
    const msg = makeMsg({ body: "The aircraft has WiFi and a fully stocked bar." });

    const result = await evaluateDraft(msg, deal);
    expect(result.issues.some((i) => i.includes("WiFi"))).toBe(true);
  });

  it("triggers revision when evaluator finds issues", async () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "quoted" });
    const msg = makeMsg({ body: "WiFi available on this flight." });

    const result = await evaluateDraft(msg, deal, {
      evaluator: async () => ({ issues: ["WiFi claim unverifiable"], pass: false }),
      reviser: async (original, issues) => original.replace("WiFi available", "Contact us about amenities"),
    });

    expect(result.wasRevised).toBe(true);
    expect(result.draft).toContain("Contact us");
    expect(result.originalBeforeRevision).toContain("WiFi");
  });

  it("catches price mismatch", async () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "quoted" });
    const msg = makeMsg({ body: "Your all-in price is $25,000 for this trip." });

    const result = await evaluateDraft(msg, deal);
    expect(result.issues.some((i) => i.includes("price") || i.includes("Price"))).toBe(true);
  });

  it("summarizes deal context correctly", () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "quoted" });
    const summary = summarizeDealForEval(deal);
    expect(summary).toContain("KTEB");
    expect(summary).toContain("KPBI");
    expect(summary).toContain("Elite Aviation");
  });
});

// ── Respond Capability ───────────────────────────────────────────────────

describe("respond capability", () => {
  it("generates draft with correct intent and confidence", async () => {
    const deal = makeDeal();
    const inbound = makeMsg({ direction: "inbound", body: "Any update?", from: "sarah@chen.com" });

    const result = await respond(deal, inbound, "follow_up");

    expect(result.draft.draftedBy).toBe("dumont");
    expect(result.draft.intent).toBe("follow_up");
    expect(result.draft.direction).toBe("outbound");
    expect(result.confidenceLevel).toBe("high");
    expect(result.draft.body).toContain("KTEB");
  });

  it("system prompt includes edit memory when available", () => {
    const { msgStore, cleanup } = makeStore();
    msgStore.save_message(makeMsg({ intent: "follow_up", editDistance: 2, originalDraft: "Dumont wrote", body: "Broker fixed" }));

    const prompt = buildRespondSystemPrompt("follow_up", "email", msgStore);
    expect(prompt).toContain("STYLE LEARNING");
    expect(prompt).toContain("Dumont wrote");
    cleanup();
  });

  it("system prompt omits edit section on cold start", () => {
    const { msgStore, cleanup } = makeStore();
    const prompt = buildRespondSystemPrompt("follow_up", "email", msgStore);
    expect(prompt).not.toContain("STYLE LEARNING");
    cleanup();
  });

  it("quote_response gets confidence=never", async () => {
    const deal = makeDeal({ operatorPhone: "+1-555-0100", stage: "quoted" });
    const inbound = makeMsg({ direction: "inbound", body: "Send me the quote" });
    const result = await respond(deal, inbound, "quote_response");
    expect(result.confidenceLevel).toBe("never");
  });

  it("uses LLM draft function when provided", async () => {
    const deal = makeDeal();
    const inbound = makeMsg({ direction: "inbound", body: "Need a quote" });
    const result = await respond(deal, inbound, "follow_up", {
      draftFn: async () => "Custom LLM-generated draft content.",
    });
    expect(result.draft.body).toBe("Custom LLM-generated draft content.");
  });
});
