/**
 * Tests for Email Adapter (Resend), Web Form Adapter, and MessageStore.
 * Per spec: communication-layer.md Sprint 3.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ResendClient } from "../src/integrations/resend.js";
import type { FetchFn, ResendInboundWebhook } from "../src/integrations/resend.js";
import { EmailAdapter } from "../src/channels/email.js";
import { WebFormAdapter } from "../src/channels/web-form.js";
import type { WebFormPayload } from "../src/channels/web-form.js";
import { MessageStore } from "../src/memory/message-store.js";
import { renderTemplate, _clearTemplateCache } from "../src/templates/render.js";
import { routeMessage } from "../src/router/message-router.js";
import type { ActiveDeal } from "../src/router/thread-matcher.js";
import { createConversation, addMessageToConversation } from "../src/schemas/conversation.js";
import { generateMessageId } from "../src/schemas/message.js";
import type { Message } from "../src/schemas/message.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import { advanceStage } from "../src/orchestrator/stage-transitions.js";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

beforeEach(() => { _resetDealCounter(); _clearTemplateCache(); });

// ── Helpers ──────────────────────────────────────────────────────────────

function mockFetch(body: Record<string, unknown> = { id: "resend_msg_001" }): FetchFn {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function mockFetchFail(status = 500): FetchFn {
  return async () => ({ ok: false, status, json: async () => ({}) });
}

function inboundEmail(overrides?: Partial<ResendInboundWebhook["data"]>): ResendInboundWebhook {
  return {
    type: "email.received",
    data: {
      id: "resend_in_001",
      from: "operator@elite-aviation.com",
      from_name: "John at Elite Aviation",
      to: ["charter@osa.aero"],
      subject: "Re: Quote Request KTEB→KPBI",
      text: "We can do this for $28,000 all-in. Phenom 300E N300EA, 2022.",
      html: "<p>We can do this for $28,000 all-in.</p>",
      headers: {
        "In-Reply-To": "<msg_original@osa.aero>",
        "References": "<msg_original@osa.aero>",
      },
      attachments: [],
      created_at: "2026-04-03T14:30:00.000Z",
      ...overrides,
    },
  };
}

function makeActiveDeal(opts?: { clientContact?: string; operatorEmail?: string; stage?: string }): ActiveDeal {
  const deal = createDealContext("live");
  updateDealContext(deal, {
    client: { name: "Test", contact: opts?.clientContact ?? "client@test.com", type: "new", budget: { min: 25000, max: 40000 }, substitutionPref: null, qualified: true, qualificationReason: "test" },
    trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: "light", aircraftType: null, isRoundTrip: false, specialRequirements: [] },
  });
  if (opts?.operatorEmail) {
    updateDealContext(deal, {
      sourcing: {
        selectedOperator: {
          operatorId: "op_001", operatorName: "Elite Aviation", phone: opts.operatorEmail,
          baseAirport: "KTEB", aircraftType: "Phenom 300E", aircraftTail: null, score: 0.85,
          scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 },
          distanceToDeparture: 0,
        },
      },
    });
  }
  if (opts?.stage) {
    const path: Record<string, string[]> = {
      qualified: ["qualified"], estimated: ["qualified", "estimated"],
      sourced: ["qualified", "estimated", "sourced"],
      quoted: ["qualified", "estimated", "sourced", "quoted"],
      presented: ["qualified", "estimated", "sourced", "quoted", "presented"],
    };
    for (const s of path[opts.stage] ?? []) advanceStage(deal, s as any);
  }
  return { deal, conversation: createConversation(deal.id) };
}

// ── Resend Client ────────────────────────────────────────────────────────

describe("ResendClient", () => {
  it("sends email with correct payload", async () => {
    let captured: unknown;
    const fetch: FetchFn = async (_url, init) => { captured = JSON.parse(init.body as string); return { ok: true, status: 200, json: async () => ({ id: "msg_001" }) }; };
    const client = new ResendClient({ apiKey: "re_test" }, fetch);

    const result = await client.sendEmail("op@test.com", "Quote Request", "<p>Hello</p>", { headers: { "In-Reply-To": "<prev>" } });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe("msg_001");
    expect((captured as any).to).toEqual(["op@test.com"]);
    expect((captured as any).subject).toBe("Quote Request");
    expect((captured as any).headers["In-Reply-To"]).toBe("<prev>");
  });

  it("handles API error", async () => {
    const client = new ResendClient({ apiKey: "re_test" }, mockFetchFail());
    const result = await client.sendEmail("op@test.com", "Test", "<p>x</p>");
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("verifies valid webhook signature", () => {
    const secret = "whsec_resend_test";
    const client = new ResendClient({ apiKey: "test", webhookSecret: secret });
    const payload = JSON.stringify(inboundEmail());
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    expect(client.verifyWebhook(payload, sig)).toBe(true);
  });

  it("rejects invalid webhook signature", () => {
    const client = new ResendClient({ apiKey: "test", webhookSecret: "secret" });
    expect(client.verifyWebhook("payload", "wrong")).toBe(false);
  });
});

// ── Email Adapter receive ────────────────────────────────────────────────

describe("EmailAdapter receive", () => {
  it("parses inbound email into Message with channel=email", () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg = adapter.receive(inboundEmail());

    expect(msg.channel).toBe("email");
    expect(msg.direction).toBe("inbound");
    expect(msg.from).toBe("operator@elite-aviation.com");
    expect(msg.fromName).toBe("John at Elite Aviation");
    expect(msg.subject).toBe("Re: Quote Request KTEB→KPBI");
    expect(msg.body).toContain("$28,000");
    expect(msg.bodyHtml).toContain("<p>");
  });

  it("extracts In-Reply-To as responseToId", () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg = adapter.receive(inboundEmail());
    expect(msg.responseToId).toBe("<msg_original@osa.aero>");
  });

  it("extracts References as threadId", () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg = adapter.receive(inboundEmail());
    expect(msg.threadId).toBe("<msg_original@osa.aero>");
  });

  it("handles email with attachments", () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg = adapter.receive(inboundEmail({
      attachments: [{ filename: "proposal.pdf", content_type: "application/pdf", url: "https://resend.com/att/1.pdf" }],
    }));

    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.filename).toBe("proposal.pdf");
    expect(msg.attachments[0]!.mimeType).toBe("application/pdf");
  });

  it("handles email with no plain text (HTML only)", () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg = adapter.receive(inboundEmail({ text: undefined, html: "<p>HTML only content</p>" }));
    expect(msg.body).toBe("HTML only content");
    expect(msg.bodyHtml).toContain("<p>");
  });

  it("handles email with no threading headers", () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg = adapter.receive(inboundEmail({ headers: {} }));
    expect(msg.responseToId).toBeNull();
    expect(msg.threadId).toBeNull();
  });
});

// ── Email Adapter deliver ────────────────────────────────────────────────

describe("EmailAdapter deliver", () => {
  it("sends with correct template for follow_up intent", async () => {
    let capturedHtml = "";
    const fetch: FetchFn = async (_url, init) => {
      const body = JSON.parse(init.body as string);
      capturedHtml = body.html;
      return { ok: true, status: 200, json: async () => ({ id: "out_001" }) };
    };
    const client = new ResendClient({ apiKey: "test" }, fetch);
    const adapter = new EmailAdapter(client);

    const msg: Message = {
      id: "msg_test", dealId: "deal_001", channel: "email", direction: "outbound",
      from: "charter@osa.aero", to: "client@test.com", fromName: null,
      subject: "Following up on your charter", body: "Just checking in on your trip plans.",
      bodyHtml: null, attachments: [], draftedBy: "dumont", approvedBy: null,
      editDistance: null, originalDraft: null, receivedAt: null,
      draftedAt: new Date().toISOString(), approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null,
      intent: "follow_up", parsedData: { recipientName: "Sarah" },
      confidence: 0.8, confidenceLevel: "high",
      platformMessageId: null, platformMetadata: null,
    };

    const result = await adapter.deliver(msg);
    expect(result.success).toBe(true);
    expect(result.platformMessageId).toBe("out_001");
    expect(capturedHtml).toContain("OSA");
    expect(capturedHtml).toContain("Just checking in");
  });

  it("sets In-Reply-To header for threading", async () => {
    let capturedHeaders: unknown;
    const fetch: FetchFn = async (_url, init) => {
      capturedHeaders = JSON.parse(init.body as string).headers;
      return { ok: true, status: 200, json: async () => ({ id: "out_002" }) };
    };
    const client = new ResendClient({ apiKey: "test" }, fetch);
    const adapter = new EmailAdapter(client);

    const msg: Message = {
      id: "msg_reply", dealId: "deal_001", channel: "email", direction: "outbound",
      from: "charter@osa.aero", to: "op@test.com", fromName: null,
      subject: "Re: Quote", body: "Thanks for the quote.",
      bodyHtml: null, attachments: [], draftedBy: "human", approvedBy: null,
      editDistance: null, originalDraft: null, receivedAt: null,
      draftedAt: null, approvedAt: null, sentAt: null,
      responseToId: "<prev_msg@resend.dev>", responseTimeMs: null, threadId: null,
      intent: "follow_up", parsedData: null, confidence: null, confidenceLevel: null,
      platformMessageId: null, platformMetadata: null,
    };

    await adapter.deliver(msg);
    expect((capturedHeaders as any)["In-Reply-To"]).toBe("<prev_msg@resend.dev>");
  });

  it("returns error when no recipient", async () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg: Message = {
      id: "msg_test", dealId: null, channel: "email", direction: "outbound",
      from: "charter@osa.aero", to: null, fromName: null,
      subject: "Test", body: "Test", bodyHtml: null, attachments: [],
      draftedBy: null, approvedBy: null, editDistance: null, originalDraft: null,
      receivedAt: null, draftedAt: null, approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null,
      intent: null, parsedData: null, confidence: null, confidenceLevel: null,
      platformMessageId: null, platformMetadata: null,
    };

    const result = await adapter.deliver(msg);
    expect(result.success).toBe(false);
  });
});

// ── Templates ────────────────────────────────────────────────────────────

describe("email templates", () => {
  it("operator-rfq renders with route, date, pax", () => {
    const html = renderTemplate("operator-rfq", { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftType: "Phenom 300E" });
    expect(html).toContain("KTEB");
    expect(html).toContain("KPBI");
    expect(html).toContain("2026-04-15");
    expect(html).toContain("4");
    expect(html).toContain("Phenom 300E");
    expect(html).not.toContain("{{");
  });

  it("client-quote renders with price, aircraft, validity", () => {
    const html = renderTemplate("client-quote", {
      clientName: "Sarah", departure: "KTEB", arrival: "KPBI", date: "2026-04-15",
      totalPrice: "$30,435", aircraftType: "Phenom 300E", aircraftYear: 2022,
      operatorName: "Elite Aviation", pax: 4, validityMinutes: 120, confirmUrl: "#",
    });
    expect(html).toContain("$30,435");
    expect(html).toContain("Sarah");
    expect(html).toContain("120");
    expect(html).toContain("Confirm");
  });

  it("templates produce valid HTML (no unclosed tags in structure)", () => {
    const html = renderTemplate("operator-rfq", { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftType: "Phenom 300E" });
    expect(html).toContain("</html>");
    expect(html).toContain("</body>");
  });

  it("confirmation template renders booking details", () => {
    const html = renderTemplate("confirmation", {
      clientName: "Sarah", departure: "KTEB", arrival: "KPBI", date: "2026-04-15",
      aircraftType: "Phenom 300E", pax: 4, totalPrice: "$30,435",
    });
    expect(html).toContain("Booking Confirmed");
    expect(html).toContain("$30,435");
  });

  it("removes unreplaced placeholders", () => {
    const html = renderTemplate("follow-up", { recipientName: "Test", body: "Hello" });
    expect(html).not.toContain("{{");
  });
});

// ── Web Form Adapter ─────────────────────────────────────────────────────

describe("WebFormAdapter", () => {
  it("parses form POST into Message with channel=web_form", () => {
    const adapter = new WebFormAdapter();
    const msg = adapter.receive({
      name: "Sarah Chen", email: "sarah@chen.com", phone: "+1-312-555-0199",
      departure: "Teterboro", arrival: "Palm Beach", date: "2026-04-15",
      pax: 4, budget: "$25,000-$35,000",
    } satisfies WebFormPayload);

    expect(msg.channel).toBe("web_form");
    expect(msg.direction).toBe("inbound");
    expect(msg.from).toBe("sarah@chen.com");
    expect(msg.fromName).toBe("Sarah Chen");
    expect(msg.intent).toBe("quote_request");
    expect(msg.body).toContain("Teterboro");
    expect(msg.body).toContain("Palm Beach");
    expect(msg.body).toContain("4 passengers");
  });

  it("maps form fields to parsedData", () => {
    const adapter = new WebFormAdapter();
    const msg = adapter.receive({
      name: "Sarah", email: "sarah@test.com",
      departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4,
    } satisfies WebFormPayload);

    expect(msg.parsedData).not.toBeNull();
    expect(msg.parsedData!["departure"]).toBe("KTEB");
    expect(msg.parsedData!["arrival"]).toBe("KPBI");
    expect(msg.parsedData!["pax"]).toBe(4);
    expect(msg.parsedData!["clientName"]).toBe("Sarah");
  });

  it("deliver is no-op returning success", async () => {
    const adapter = new WebFormAdapter();
    const result = await adapter.deliver({} as any);
    expect(result.success).toBe(true);
    expect(result.platformMessageId).toBeNull();
  });

  it("handles missing optional fields", () => {
    const adapter = new WebFormAdapter();
    const msg = adapter.receive({ name: "Test", email: "test@test.com" } satisfies WebFormPayload);

    expect(msg.channel).toBe("web_form");
    expect(msg.from).toBe("test@test.com");
    expect(msg.parsedData!["clientName"]).toBe("Test");
  });

  it("supportsRealtime returns false", () => {
    expect(new WebFormAdapter().supportsRealtime()).toBe(false);
  });
});

// ── MessageStore ─────────────────────────────────────────────────────────

describe("MessageStore", () => {
  function makeStore(): { store: MessageStore; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "dumont-msgstore-"));
    const path = join(dir, "messages.json");
    writeFileSync(path, "[]");
    return { store: new MessageStore(path), cleanup: () => rmSync(dir, { recursive: true }) };
  }

  function makeMsg(overrides: Partial<Message> = {}): Message {
    return {
      id: generateMessageId(), dealId: "deal_001", channel: "email", direction: "inbound",
      from: "test@test.com", to: "charter@osa.aero", fromName: null, subject: null,
      body: "Test message", bodyHtml: null, attachments: [],
      draftedBy: null, approvedBy: null, editDistance: null, originalDraft: null,
      receivedAt: new Date().toISOString(), draftedAt: null, approvedAt: null, sentAt: null,
      responseToId: null, responseTimeMs: null, threadId: null,
      intent: null, parsedData: null, confidence: null, confidenceLevel: null,
      platformMessageId: null, platformMetadata: null,
      ...overrides,
    };
  }

  it("save persists and getByDealId retrieves", () => {
    const { store, cleanup } = makeStore();
    const msg = makeMsg({ dealId: "deal_001" });
    store.saveMessage(msg);

    expect(store.getByDealId("deal_001")).toHaveLength(1);
    expect(store.getByDealId("deal_001")[0]!.id).toBe(msg.id);
    cleanup();
  });

  it("getByMessageId returns correct message", () => {
    const { store, cleanup } = makeStore();
    const msg = makeMsg({ id: "msg_specific" });
    store.saveMessage(msg);

    expect(store.getByMessageId("msg_specific")).not.toBeNull();
    expect(store.getByMessageId("msg_specific")!.body).toBe("Test message");
    expect(store.getByMessageId("msg_nonexistent")).toBeNull();
    cleanup();
  });

  it("getByContact filters by sender", () => {
    const { store, cleanup } = makeStore();
    store.saveMessage(makeMsg({ from: "sarah@chen.com" }));
    store.saveMessage(makeMsg({ from: "other@person.com" }));
    store.saveMessage(makeMsg({ from: "sarah@chen.com" }));

    expect(store.getByContact("sarah@chen.com")).toHaveLength(2);
    expect(store.getByContact("other@person.com")).toHaveLength(1);
    cleanup();
  });

  it("count returns total messages", () => {
    const { store, cleanup } = makeStore();
    store.saveMessage(makeMsg());
    store.saveMessage(makeMsg());
    expect(store.count).toBe(2);
    cleanup();
  });
});

// ── Router Integration ───────────────────────────────────────────────────

describe("router integration", () => {
  it("inbound email from unknown sender creates new deal", async () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const msg = adapter.receive(inboundEmail({ from: "unknown@person.com", headers: {} }));
    const result = await routeMessage(msg, [], {
      createDeal: async () => createDealContext("live"),
    });

    expect(result.isNewDeal).toBe(true);
  });

  it("inbound email with In-Reply-To matches existing deal", async () => {
    const client = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(client);

    const ad = makeActiveDeal({ operatorEmail: "operator@elite-aviation.com", stage: "sourced" });
    const originalMsg = { id: "<msg_original@osa.aero>", dealId: ad.deal.id, channel: "email" as const, direction: "outbound" as const, from: "charter@osa.aero", to: "operator@elite-aviation.com", fromName: null, subject: "Quote Request", body: "Requesting quote.", bodyHtml: null, attachments: [], draftedBy: null, approvedBy: null, editDistance: null, originalDraft: null, receivedAt: null, draftedAt: null, approvedAt: null, sentAt: new Date().toISOString(), responseToId: null, responseTimeMs: null, threadId: null, intent: null, parsedData: null, confidence: null, confidenceLevel: null, platformMessageId: null, platformMetadata: null };
    addMessageToConversation(ad.conversation, originalMsg);

    const replyMsg = adapter.receive(inboundEmail());
    const result = await routeMessage(replyMsg, [ad], { createDeal: async () => createDealContext("live") });

    expect(result.isNewDeal).toBe(false);
    expect(result.deal.id).toBe(ad.deal.id);
  });

  it("web form submission creates new deal with pre-parsed data", async () => {
    const adapter = new WebFormAdapter();
    const msg = adapter.receive({
      name: "Sarah", email: "sarah@chen.com",
      departure: "Teterboro", arrival: "Palm Beach", date: "2026-04-15", pax: 4,
    } satisfies WebFormPayload);

    const result = await routeMessage(msg, [], { createDeal: async () => createDealContext("live") });
    expect(result.isNewDeal).toBe(true);
    expect(result.conversation.messages[0]!.parsedData!["departure"]).toBe("Teterboro");
  });

  it("operator email with price triggers advance_to_quoted action", async () => {
    const resendClient = new ResendClient({ apiKey: "test" }, mockFetch());
    const adapter = new EmailAdapter(resendClient);

    const ad = makeActiveDeal({ operatorEmail: "operator@elite-aviation.com", stage: "sourced" });

    const msg = adapter.receive(inboundEmail({ from: "operator@elite-aviation.com", text: "Best price: $28,000 all-in for April 15." }));
    const result = await routeMessage(msg, [ad], { createDeal: async () => createDealContext("live") });

    expect(result.intent).toBe("quote_response");
    expect(result.action.type).toBe("advance_to_quoted");
    if (result.action.type === "advance_to_quoted") {
      expect(result.action.operatorPrice).toBe(28000);
    }
  });
});
