/**
 * Tests for Voice Copilot Pipeline — Twilio + Deepgram + TranscriptProcessor.
 * Per spec: communication-layer.md Sprint 4, FR-5, section 2.3.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TwilioClient } from "../src/integrations/twilio.js";
import type { FetchFn as TwilioFetchFn } from "../src/integrations/twilio.js";
import { DeepgramClient, AVIATION_VOCABULARY } from "../src/integrations/deepgram.js";
import type { MockableWebSocket, TranscriptCallback } from "../src/integrations/deepgram.js";
import { processChunk, extractAllEntities, extractPrice, generateSummary } from "../src/capabilities/transcript-processor.js";
import type { TranscriptChunk, DetectedEntity, Call } from "../src/schemas/call.js";
import { VoiceCopilotAdapter, generateCallBrief } from "../src/channels/voice.js";
import { CallStore } from "../src/memory/call-store.js";
import { createDealContext, updateDealContext } from "../src/orchestrator/deal-context-manager.js";
import { createTestDb } from "../src/memory/database.js";
// ── Mock helpers ─────────────────────────────────────────────────────────

function twilioFetch(responses: Record<string, unknown>[] = [{ sid: "CF_test_123", status: "init" }]): TwilioFetchFn {
  let i = 0;
  return async () => ({ ok: true, status: 200, json: async () => responses[Math.min(i++, responses.length - 1)]! });
}

function twilioFetchFail(): TwilioFetchFn {
  return async () => ({ ok: false, status: 500, json: async () => ({ error: "fail" }) });
}

function mockWsFactory(): { factory: (url: string) => MockableWebSocket; ws: MockableWebSocket; lastUrl: string } {
  let lastUrl = "";
  const ws: MockableWebSocket = {
    send: () => {},
    close: () => {},
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: 1,
  };
  return { factory: (url: string) => { lastUrl = url; return ws; }, ws, get lastUrl() { return lastUrl; } };
}

function makeChunk(text: string, speaker = "counterparty", timestampMs = 0): TranscriptChunk {
  return { chunkId: `chunk_${Date.now()}`, speaker: speaker as "broker" | "counterparty", text, timestampMs, durationMs: 1000, confidence: 0.95, isFinal: true, detectedEntities: [] };
}

function makeCall(): Call {
  return {
    callId: "call_001", dealId: "deal_001", direction: "outbound_to_operator",
    participants: [
      { name: "Phelipe", role: "broker", phone: "+1-773-555-0100" },
      { name: "John", role: "operator", phone: "+1-555-0200" },
    ],
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    durationSec: 330, transcript: [makeChunk("We can do $28,000 all-in for the Phenom 300E")],
    detectedEntities: [{ type: "price", value: "$28,000", raw: "$28,000", speaker: "counterparty", confidence: 0.95, timestampMs: 12000 }],
    summary: "Operator quoted $28,000 for Phenom 300E KTEB→KPBI.",
    recordingUrl: "https://recordings.twilio.com/call_001.wav",
    recordingExpiresAt: null,
  };
}

// ── Twilio Client ────────────────────────────────────────────────────────

describe("TwilioClient", () => {
  it("createConference returns conference SID", async () => {
    const client = new TwilioClient({ accountSid: "AC_test", authToken: "token" }, twilioFetch([{ sid: "CF_abc", status: "init" }]));
    const conf = await client.createConference("deal_001");
    expect(conf.conferenceSid).toBe("CF_abc");
    expect(conf.friendlyName).toBe("deal_001");
  });

  it("addParticipant adds with correct label and muted flag", async () => {
    let capturedBody = "";
    const fetch: TwilioFetchFn = async (_url, init) => { capturedBody = init.body as string; return { ok: true, status: 200, json: async () => ({ call_sid: "CA_part1" }) }; };
    const client = new TwilioClient({ accountSid: "AC_test", authToken: "token" }, fetch);

    const part = await client.addParticipant("CF_abc", "+1-555-0100", { label: "broker", muted: false });
    expect(part.callSid).toBe("CA_part1");
    expect(part.label).toBe("broker");
    expect(capturedBody).toContain("Label=broker");
    expect(capturedBody).not.toContain("Muted");
  });

  it("addParticipant includes announceUrl for consent disclosure", async () => {
    let capturedBody = "";
    const fetch: TwilioFetchFn = async (_url, init) => { capturedBody = init.body as string; return { ok: true, status: 200, json: async () => ({ call_sid: "CA_op" }) }; };
    const client = new TwilioClient({ accountSid: "AC_test", authToken: "token" }, fetch);

    await client.addParticipant("CF_abc", "+1-555-0200", {
      label: "operator", muted: false, announceUrl: "/audio/disclosure.mp3",
    });
    expect(capturedBody).toContain("AnnounceUrl");
    expect(capturedBody).toContain("disclosure.mp3");
  });

  it("startStream sends correct WebSocket URL", async () => {
    let capturedBody = "";
    const fetch: TwilioFetchFn = async (_url, init) => { capturedBody = init.body as string; return { ok: true, status: 200, json: async () => ({ sid: "MZ_stream" }) }; };
    const client = new TwilioClient({ accountSid: "AC_test", authToken: "token" }, fetch);

    const stream = await client.startStream("CF_abc", "wss://transcribe.example.com");
    expect(stream.streamSid).toBe("MZ_stream");
    expect(capturedBody).toContain("transcribe.example.com");
  });

  it("endConference terminates cleanly", async () => {
    let capturedBody = "";
    const fetch: TwilioFetchFn = async (_url, init) => { capturedBody = init.body as string; return { ok: true, status: 200, json: async () => ({}) }; };
    const client = new TwilioClient({ accountSid: "AC_test", authToken: "token" }, fetch);

    await client.endConference("CF_abc");
    expect(capturedBody).toContain("Status=completed");
  });
});

// ── Deepgram Client ──────────────────────────────────────────────────────

describe("DeepgramClient", () => {
  it("createStreamingSession opens with correct config", () => {
    const { factory } = mockWsFactory();
    const client = new DeepgramClient({ apiKey: "dg_test" }, factory);

    const session = client.createStreamingSession();
    expect(session.model).toBe("nova-2");
    expect(session.language).toBe("en");
    expect(session.vocabularySize).toBeGreaterThan(20);
  });

  it("custom aviation vocabulary included", () => {
    expect(AVIATION_VOCABULARY).toContain("KTEB");
    expect(AVIATION_VOCABULARY).toContain("Phenom 300E");
    expect(AVIATION_VOCABULARY).toContain("Challenger 300");
    expect(AVIATION_VOCABULARY).toContain("all-in");
    expect(AVIATION_VOCABULARY).toContain("Part 135");
  });

  it("onTranscript fires callback with speaker + text + timing", () => {
    const { factory, ws } = mockWsFactory();
    const client = new DeepgramClient({ apiKey: "dg_test" }, factory);
    client.createStreamingSession();

    let received: Parameters<TranscriptCallback>[0] | null = null;
    client.onTranscript((chunk) => { received = chunk; });

    // Simulate Deepgram message
    ws.onmessage!({ data: JSON.stringify({
      channel: { alternatives: [{ transcript: "twenty-eight thousand all-in", confidence: 0.92, words: [{ speaker: 1 }] }] },
      start: 12.5, duration: 2.1, is_final: true,
    }) });

    expect(received).not.toBeNull();
    expect(received!.text).toBe("twenty-eight thousand all-in");
    expect(received!.speaker).toBe(1);
    expect(received!.confidence).toBe(0.92);
    expect(received!.isFinal).toBe(true);
  });

  it("close terminates session", () => {
    const { factory, ws } = mockWsFactory();
    let closed = false;
    ws.close = () => { closed = true; };
    const client = new DeepgramClient({ apiKey: "dg_test" }, factory);
    client.createStreamingSession();

    client.close();
    expect(closed).toBe(true);
  });
});

// ── TranscriptProcessor ──────────────────────────────────────────────────

describe("TranscriptProcessor", () => {
  it("detects price from '$28,000'", () => {
    const entities = processChunk(makeChunk("We can do this for $28,000 all-in"));
    const price = entities.find((e) => e.type === "price");
    expect(price).toBeDefined();
    expect(price!.value).toBe("$28,000");
  });

  it("detects price from 'twenty-eight five' (= $28,500)", () => {
    expect(extractPrice("twenty-eight five")).toBe(28500);
  });

  it("detects price from '$32k'", () => {
    expect(extractPrice("$32k")).toBe(32000);
  });

  it("detects tail number from 'november three hundred echo lima'", () => {
    const entities = processChunk(makeChunk("The tail is november three hundred echo lima"));
    const tail = entities.find((e) => e.type === "tail_number");
    expect(tail).toBeDefined();
    expect(tail!.value).toBe("N300EL");
  });

  it("detects direct tail number 'N300EA'", () => {
    const entities = processChunk(makeChunk("Aircraft N300EA is available"));
    const tail = entities.find((e) => e.type === "tail_number");
    expect(tail!.value).toBe("N300EA");
  });

  it("detects aircraft type 'Challenger 300'", () => {
    const entities = processChunk(makeChunk("We have a Challenger 300 available"));
    const ac = entities.find((e) => e.type === "aircraft_type");
    expect(ac).toBeDefined();
    expect(ac!.value).toContain("Challenger");
  });

  it("detects airport code 'KTEB'", () => {
    const entities = processChunk(makeChunk("Departing from KTEB to KPBI"));
    const airports = entities.filter((e) => e.type === "airport");
    expect(airports.length).toBe(2);
    expect(airports.map((a) => a.value)).toContain("KTEB");
    expect(airports.map((a) => a.value)).toContain("KPBI");
  });

  it("detects availability 'not available'", () => {
    const entities = processChunk(makeChunk("Sorry, that aircraft is not available"));
    const avail = entities.find((e) => e.type === "availability");
    expect(avail).toBeDefined();
    expect(avail!.value).toBe("false");
  });

  it("detects availability 'available'", () => {
    const entities = processChunk(makeChunk("Yes, the aircraft is available for that date"));
    const avail = entities.find((e) => e.type === "availability");
    expect(avail!.value).toBe("true");
  });

  it("detects hold duration 'hold it for two hours'", () => {
    const entities = processChunk(makeChunk("I can hold it for two hours"));
    const hold = entities.find((e) => e.type === "hold_duration");
    expect(hold).toBeDefined();
    expect(hold!.value).toBe("120min");
  });

  it("detects negotiation signal 'best I can do' as firm", () => {
    const entities = processChunk(makeChunk("That's the best I can do on this route"));
    const sig = entities.find((e) => e.type === "negotiation_signal");
    expect(sig).toBeDefined();
    expect(sig!.value).toBe("firm");
  });

  it("detects negotiation signal 'I might be able to' as flexible", () => {
    const entities = processChunk(makeChunk("I might be able to come down a bit"));
    const sig = entities.find((e) => e.type === "negotiation_signal");
    expect(sig!.value).toBe("flexible");
  });

  it("detects negotiation signal 'let me check' as checking", () => {
    const entities = processChunk(makeChunk("Let me check on the schedule"));
    const sig = entities.find((e) => e.type === "negotiation_signal");
    expect(sig!.value).toBe("checking");
  });

  it("returns empty array when no entities in chunk", () => {
    const entities = processChunk(makeChunk("Hello, good morning"));
    expect(entities).toHaveLength(0);
  });

  it("post-call batch extraction finds all entities", () => {
    const chunks = [
      makeChunk("The Phenom 300E N300EA is available from KTEB"),
      makeChunk("Best price is $28,000 all-in"),
      makeChunk("I can hold it for two hours"),
    ];
    const entities = extractAllEntities(chunks);

    const types = entities.map((e) => e.type);
    expect(types).toContain("aircraft_type");
    expect(types).toContain("tail_number");
    expect(types).toContain("airport");
    expect(types).toContain("price");
    expect(types).toContain("hold_duration");
  });

  it("post-call summary generation (mock)", async () => {
    const chunks = [makeChunk("Quoted $28,000 for Phenom 300E")];
    const entities: DetectedEntity[] = [
      { type: "price", value: "$28,000", raw: "$28,000", speaker: "counterparty", confidence: 0.95, timestampMs: 1000 },
    ];

    const summary = await generateSummary(chunks, entities, {
      summarize: async (transcript, ents) => `Call summary: ${ents.length} entities detected.`,
    });

    expect(summary).toContain("1 entities");
  });

  it("default summary without LLM includes prices and aircraft", async () => {
    const chunks = [makeChunk("Challenger 300 available at $32,000")];
    const entities: DetectedEntity[] = [
      { type: "price", value: "$32,000", raw: "$32,000", speaker: "counterparty", confidence: 0.9, timestampMs: 0 },
      { type: "aircraft_type", value: "Challenger 300", raw: "challenger 300", speaker: "counterparty", confidence: 0.9, timestampMs: 0 },
    ];

    const summary = await generateSummary(chunks, entities);
    expect(summary).toContain("$32,000");
    expect(summary).toContain("Challenger 300");
  });
});

// ── Voice Copilot Adapter ────────────────────────────────────────────────

describe("VoiceCopilotAdapter", () => {
  it("receive creates Message with channel=voice_copilot", () => {
    const adapter = new VoiceCopilotAdapter();
    const msg = adapter.receive(makeCall());

    expect(msg.channel).toBe("voice_copilot");
    expect(msg.direction).toBe("inbound");
    expect(msg.from).toBe("+1-555-0200"); // operator
    expect(msg.body).toContain("$28,000");
    expect(msg.threadId).toBe("call_001");
  });

  it("deliver is no-op", async () => {
    const adapter = new VoiceCopilotAdapter();
    const result = await adapter.deliver({} as any);
    expect(result.success).toBe(true);
  });

  it("supportsRealtime returns true", () => {
    expect(new VoiceCopilotAdapter().supportsRealtime()).toBe(true);
  });
});

// ── Call Brief ────────────────────────────────────────────────────────────

describe("generateCallBrief", () => {
  it("includes deal context (route, estimate, operator)", () => {
    const deal = createDealContext("live");
    updateDealContext(deal, {
      trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: "light", aircraftType: null, isRoundTrip: false, specialRequirements: [] },
      client: { name: "Test", contact: "t@t.com", type: "new", budget: { min: 25000, max: 40000 }, substitutionPref: null, qualified: true, qualificationReason: "test" },
      estimate: { source: "aviapages", flightTime: 150, priceRange: { low: 25000, high: 35000 }, fuelBurn: 280, positioning: null, calculatedAt: new Date().toISOString() },
      sourcing: { selectedOperator: { operatorId: "op_001", operatorName: "Elite Aviation", phone: null, baseAirport: "KTEB", aircraftType: "Phenom 300E", aircraftTail: null, score: 0.85, scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 }, distanceToDeparture: 0 }, backupOperator: null, rankingReason: "test", laneHistory: [] },
    });

    const brief = generateCallBrief(deal);

    expect(brief.route).toBe("KTEB → KPBI");
    expect(brief.pax).toBe(4);
    expect(brief.operatorName).toBe("Elite Aviation");
    expect(brief.estimateRange).toContain("$25,000");
    expect(brief.talkingPoints.length).toBeGreaterThan(0);
    expect(brief.talkingPoints.some((p) => p.includes("budget"))).toBe(true);
  });
});

// ── CallStore ────────────────────────────────────────────────────────────

describe("CallStore", () => {
  function makeStore(): { store: CallStore; cleanup: () => void } {
    const db = createTestDb();
    return { store: new CallStore(db), cleanup: () => db.close() };
  }

  it("save persists and getByDealId retrieves", () => {
    const { store, cleanup } = makeStore();
    store.saveCall(makeCall());

    expect(store.getByDealId("deal_001")).toHaveLength(1);
    expect(store.getByDealId("deal_001")[0]!.callId).toBe("call_001");
    cleanup();
  });

  it("getById returns correct call", () => {
    const { store, cleanup } = makeStore();
    store.saveCall(makeCall());

    expect(store.getById("call_001")).not.toBeNull();
    expect(store.getById("call_999")).toBeNull();
    cleanup();
  });

  it("count returns total calls", () => {
    const { store, cleanup } = makeStore();
    store.saveCall(makeCall());
    expect(store.count).toBe(1);
    cleanup();
  });
});

// ── Integration ──────────────────────────────────────────────────────────

describe("integration: entity detection updates deal context", () => {
  it("detected price entity can be used to update deal", () => {
    const chunks = [makeChunk("We can do $28,000 all-in for the Phenom 300E N300EA")];
    const entities = extractAllEntities(chunks);

    const prices = entities.filter((e) => e.type === "price");
    expect(prices.length).toBeGreaterThan(0);

    // Simulate: router would take this price and create an advance_to_quoted action
    const price = parseFloat(prices[0]!.value.replace(/[$,]/g, ""));
    expect(price).toBe(28000);
  });
});
