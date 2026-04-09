/**
 * Tests for Bland AI Channel Adapter — voice SDR + iMessage + SMS.
 * Per spec: communication-layer.md Sprint 2.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { BlandAiClient } from "../src/integrations/bland-ai.js";
import type { FetchFn, BlandVoiceWebhook, BlandSmsWebhook } from "../src/integrations/bland-ai.js";
import { BlandAiAdapter } from "../src/channels/bland-ai.js";
import { routeMessage } from "../src/router/message-router.js";
import type { ActiveDeal } from "../src/router/thread-matcher.js";
import { createConversation } from "../src/schemas/conversation.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import type { DealContext } from "../src/schemas/deal-context.js";
import { createHmac } from "node:crypto";

beforeEach(() => _resetDealCounter());

// ── Fixtures ─────────────────────────────────────────────────────────────

function voiceWebhook(overrides?: Partial<BlandVoiceWebhook>): BlandVoiceWebhook {
  return {
    call_id: "call_abc123",
    call_type: "voice",
    from: "+1-312-555-0199",
    to: "+1-773-555-0100",
    status: "completed",
    started_at: "2026-04-03T14:00:00.000Z",
    ended_at: "2026-04-03T14:05:30.000Z",
    duration: 330,
    transcript: "Hi, I need to charter a flight from Teterboro to Palm Beach on April 15th for 4 passengers. Budget around thirty thousand.",
    summary: "Client requests TEB to PBI, April 15, 4 pax, ~$30K budget.",
    analysis: {
      departure: "KTEB",
      arrival: "KPBI",
      date: "2026-04-15",
      pax: 4,
      budget_min: 25000,
      budget_max: 35000,
      client_name: "Sarah Chen",
      client_phone: "+1-312-555-0199",
      callback_preference: "text",
    },
    recording_url: "https://recordings.bland.ai/call_abc123.wav",
    ...overrides,
  };
}

function smsWebhook(overrides?: Partial<BlandSmsWebhook>): BlandSmsWebhook {
  return {
    message_id: "msg_sms_456",
    message_type: "imessage",
    from: "+1-312-555-0199",
    to: "+1-773-555-0100",
    body: "Any update on my flight quote?",
    received_at: "2026-04-03T15:00:00.000Z",
    ...overrides,
  };
}

function mockFetchSuccess(responseBody: Record<string, unknown> = { message_id: "msg_out_789" }): FetchFn {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => responseBody,
  });
}

function mockFetchFailure(status = 500): FetchFn {
  return async () => ({
    ok: false,
    status,
    json: async () => ({ error: "Internal server error" }),
  });
}

function mockFetchThrows(): FetchFn {
  return async () => { throw new Error("Network error"); };
}

// ── Voice Webhook Tests ──────────────────────────────────────────────────

describe("voice webhook → Message", () => {
  it("parses voice webhook into Message with channel=bland_voice", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook());

    expect(msg.channel).toBe("bland_voice");
    expect(msg.direction).toBe("inbound");
    expect(msg.from).toBe("+1-312-555-0199");
    expect(msg.to).toBe("+1-773-555-0100");
    expect(msg.body).toContain("TEB to PBI");
    expect(msg.platformMessageId).toBe("call_abc123");
    expect(msg.threadId).toBe("call_abc123");
  });

  it("extracts structured fields into parsedData", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook());

    expect(msg.parsedData).not.toBeNull();
    expect(msg.parsedData!["departure"]).toBe("KTEB");
    expect(msg.parsedData!["arrival"]).toBe("KPBI");
    expect(msg.parsedData!["date"]).toBe("2026-04-15");
    expect(msg.parsedData!["pax"]).toBe(4);
    expect(msg.parsedData!["budget"]).toEqual({ min: 25000, max: 35000 });
    expect(msg.parsedData!["clientName"]).toBe("Sarah Chen");
  });

  it("sets from to caller phone number", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook({ from: "+1-212-555-9999" }));
    expect(msg.from).toBe("+1-212-555-9999");
  });

  it("sets fromName from analysis client_name", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook());
    expect(msg.fromName).toBe("Sarah Chen");
  });

  it("handles webhook with missing analysis fields gracefully", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook({ analysis: undefined }));

    expect(msg.parsedData).toBeNull();
    expect(msg.fromName).toBeNull();
    expect(msg.channel).toBe("bland_voice");
  });

  it("handles webhook with empty transcript", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook({ transcript: "", summary: undefined }));

    expect(msg.body).toBe("");
    expect(msg.channel).toBe("bland_voice");
  });

  it("includes recording URL in platformMetadata", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook());

    expect(msg.platformMetadata).not.toBeNull();
    expect(msg.platformMetadata!["recordingUrl"]).toContain("call_abc123.wav");
    expect(msg.platformMetadata!["callDuration"]).toBe(330);
  });
});

// ── SMS/iMessage Webhook Tests ───────────────────────────────────────────

describe("SMS/iMessage webhook → Message", () => {
  it("parses SMS webhook into Message with channel=bland_text", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(smsWebhook());

    expect(msg.channel).toBe("bland_text");
    expect(msg.direction).toBe("inbound");
    expect(msg.body).toBe("Any update on my flight quote?");
    expect(msg.from).toBe("+1-312-555-0199");
    expect(msg.platformMessageId).toBe("msg_sms_456");
  });

  it("preserves message type in platformMetadata", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(smsWebhook({ message_type: "imessage" }));
    expect(msg.platformMetadata!["messageType"]).toBe("imessage");

    const msg2 = adapter.receive(smsWebhook({ message_type: "sms" }));
    expect(msg2.platformMetadata!["messageType"]).toBe("sms");
  });

  it("handles multimedia message (image URL in attachments)", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(smsWebhook({
      body: "Here's my passport",
      media_urls: ["https://media.bland.ai/img1.jpg", "https://media.bland.ai/img2.png"],
    }));

    expect(msg.attachments).toHaveLength(2);
    expect(msg.attachments[0]!.url).toContain("img1.jpg");
  });

  it("parsedData is null for SMS (router runs extractors)", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(smsWebhook());
    expect(msg.parsedData).toBeNull();
  });
});

// ── Outbound Delivery Tests ──────────────────────────────────────────────

describe("deliver (outbound)", () => {
  it("calls Bland AI send API with correct phone + body", async () => {
    let capturedBody: unknown;
    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return { ok: true, status: 200, json: async () => ({ message_id: "msg_out_001" }) };
    };
    const client = new BlandAiClient({ apiKey: "test-key", phoneNumber: "+1-773-555-0100" }, captureFetch);
    const adapter = new BlandAiAdapter(client);

    const msg = {
      id: "msg_test", dealId: null, channel: "bland_text" as const, direction: "outbound" as const,
      from: "+1-773-555-0100", to: "+1-312-555-0199", fromName: null, subject: null,
      body: "Your quote is ready!", bodyHtml: null, attachments: [],
      draftedBy: "dumont" as const, approvedBy: null, editDistance: null, originalDraft: null,
      receivedAt: null, draftedAt: new Date().toISOString(), approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null, intent: null,
      parsedData: null, confidence: null, confidenceLevel: null,
      platformMessageId: null, platformMetadata: null,
    };

    const result = await adapter.deliver(msg);

    expect(result.success).toBe(true);
    expect(result.platformMessageId).toBe("msg_out_001");
    expect((capturedBody as Record<string, unknown>)["to"]).toBe("+1-312-555-0199");
    expect((capturedBody as Record<string, unknown>)["body"]).toBe("Your quote is ready!");
  });

  it("returns failure when API errors", async () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchFailure());
    const adapter = new BlandAiAdapter(client);

    const msg = {
      id: "msg_test", dealId: null, channel: "bland_text" as const, direction: "outbound" as const,
      from: "+1-773-555-0100", to: "+1-312-555-0199", fromName: null, subject: null,
      body: "Test", bodyHtml: null, attachments: [],
      draftedBy: null, approvedBy: null, editDistance: null, originalDraft: null,
      receivedAt: null, draftedAt: null, approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null, intent: null,
      parsedData: null, confidence: null, confidenceLevel: null,
      platformMessageId: null, platformMetadata: null,
    };

    const result = await adapter.deliver(msg);
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("returns failure when no recipient phone", async () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = {
      id: "msg_test", dealId: null, channel: "bland_text" as const, direction: "outbound" as const,
      from: "+1-773-555-0100", to: null, fromName: null, subject: null,
      body: "Test", bodyHtml: null, attachments: [],
      draftedBy: null, approvedBy: null, editDistance: null, originalDraft: null,
      receivedAt: null, draftedAt: null, approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null, intent: null,
      parsedData: null, confidence: null, confidenceLevel: null,
      platformMessageId: null, platformMetadata: null,
    };

    const result = await adapter.deliver(msg);
    expect(result.success).toBe(false);
    expect(result.error).toContain("No recipient");
  });

  it("handles network error gracefully", async () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchThrows());
    const adapter = new BlandAiAdapter(client);

    const msg = {
      id: "msg_test", dealId: null, channel: "bland_text" as const, direction: "outbound" as const,
      from: "+1-773-555-0100", to: "+1-312-555-0199", fromName: null, subject: null,
      body: "Test", bodyHtml: null, attachments: [],
      draftedBy: null, approvedBy: null, editDistance: null, originalDraft: null,
      receivedAt: null, draftedAt: null, approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null, intent: null,
      parsedData: null, confidence: null, confidenceLevel: null,
      platformMessageId: null, platformMetadata: null,
    };

    const result = await adapter.deliver(msg);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
  });
});

// ── Webhook Signature Verification ───────────────────────────────────────

describe("webhook signature verification", () => {
  const secret = "whsec_test_secret_123";

  it("accepts valid signature", () => {
    const client = new BlandAiClient({ apiKey: "test", webhookSecret: secret });
    const payload = JSON.stringify(voiceWebhook());
    const signature = createHmac("sha256", secret).update(payload).digest("hex");

    expect(client.verifyWebhook(payload, signature)).toBe(true);
  });

  it("rejects invalid signature", () => {
    const client = new BlandAiClient({ apiKey: "test", webhookSecret: secret });
    const payload = JSON.stringify(voiceWebhook());

    expect(client.verifyWebhook(payload, "invalid_signature")).toBe(false);
  });

  it("rejects when no secret configured (fail-closed)", () => {
    const client = new BlandAiClient({ apiKey: "test" }); // no webhookSecret
    const payload = JSON.stringify(voiceWebhook());

    expect(client.verifyWebhook(payload, "anything")).toBe(false);
  });

  it("rejects tampered payload", () => {
    const client = new BlandAiClient({ apiKey: "test", webhookSecret: secret });
    const original = JSON.stringify(voiceWebhook());
    const signature = createHmac("sha256", secret).update(original).digest("hex");

    const tampered = JSON.stringify({ ...voiceWebhook(), from: "+1-999-999-9999" });
    expect(client.verifyWebhook(tampered, signature)).toBe(false);
  });
});

// ── Adapter Edge Cases ───────────────────────────────────────────────────

describe("adapter edge cases", () => {
  it("throws on unknown webhook type", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    expect(() => adapter.receive({ type: "unknown" })).toThrow("Unknown Bland AI webhook type");
  });

  it("supportsRealtime returns false", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);
    expect(adapter.supportsRealtime()).toBe(false);
  });

  it("uses summary over transcript when both available", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook({
      summary: "Short summary",
      transcript: "Very long transcript text...",
    }));
    expect(msg.body).toBe("Short summary");
  });

  it("falls back to transcript when no summary", () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook({
      summary: undefined,
      transcript: "Full transcript here",
    }));
    expect(msg.body).toBe("Full transcript here");
  });
});

// ── Integration with Message Router ──────────────────────────────────────

describe("integration with message router", () => {
  it("voice webhook routes through MessageRouter to create new deal", async () => {
    const client = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(client);

    const msg = adapter.receive(voiceWebhook());
    const result = await routeMessage(msg, [], {
      createDeal: async () => createDealContext("live"),
    });

    expect(result.isNewDeal).toBe(true);
    expect(msg.dealId).toBe(result.deal.id);
    expect(result.conversation.touchpointCount).toBe(1);
  });

  it("SMS webhook routes through MessageRouter to existing deal by phone", async () => {
    const blandClient = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(blandClient);

    // Create existing deal with matching phone
    const deal = createDealContext("live");
    updateDealContext(deal, {
      client: { name: "Sarah", contact: "+1-312-555-0199", type: "new", budget: null, substitutionPref: null, qualified: true, qualificationReason: "test" },
      trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: null, aircraftType: null, isRoundTrip: false, specialRequirements: [] },
    });
    const activeDeal: ActiveDeal = { deal, conversation: createConversation(deal.id) };

    const msg = adapter.receive(smsWebhook({ from: "+1-312-555-0199" }));
    const result = await routeMessage(msg, [activeDeal], {
      createDeal: async () => createDealContext("live"),
    });

    expect(result.isNewDeal).toBe(false);
    expect(result.deal.id).toBe(deal.id);
  });

  it("voice webhook with full analysis carries parsedData into deal", async () => {
    const blandClient = new BlandAiClient({ apiKey: "test" }, mockFetchSuccess());
    const adapter = new BlandAiAdapter(blandClient);

    const msg = adapter.receive(voiceWebhook());

    expect(msg.parsedData).not.toBeNull();
    expect(msg.parsedData!["departure"]).toBe("KTEB");
    expect(msg.parsedData!["pax"]).toBe(4);

    // Route creates a new deal — parsedData is on the message, not the deal
    // (The orchestrator will use parsedData to populate DealContext in production)
    const result = await routeMessage(msg, [], {
      createDeal: async () => createDealContext("live"),
    });

    expect(result.isNewDeal).toBe(true);
    expect(result.conversation.messages[0]!.parsedData!["departure"]).toBe("KTEB");
  });
});
