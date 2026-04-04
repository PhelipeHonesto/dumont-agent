/**
 * Tests for Intake capability — request parsing, qualification, repeat detection.
 *
 * Test fixtures cover:
 * 1. Clean text request — all fields parseable
 * 2. Email format — multi-line with signature
 * 3. Ambiguous airport — city resolution
 * 4. Missing budget — qualified but budget null (pipeline pauses)
 * 5. Repeat client detection — from DealStore memory
 * 6. Edge cases — SMS shorthand, multiple formats, partial data
 *
 * No LLM calls — tests use code-layer parsing and mock LLM where needed.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseRequestText,
  qualify,
  detectRepeatClient,
  resolveIcao,
  extractPax,
  extractBudget,
  extractDate,
  extractAircraftClass,
  extractRoute,
  extractClientName,
  extractContact,
  extractSpecialRequirements,
  isRoundTrip,
  intake,
} from "../src/capabilities/intake.js";
import type { ParsedRequest } from "../src/capabilities/intake.js";
import { createDealContext } from "../src/orchestrator/deal-context-manager.js";
import { _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import { DealStore } from "../src/memory/deal-store.js";
import type { DealRecord } from "../src/schemas/deal-record.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test Fixtures ─────────────────────────────────────────────────────────

const TODAY = new Date("2026-03-31T12:00:00Z");

const FIXTURES = {
  /** Clean text: all critical fields present and unambiguous. */
  cleanText: "I need a light jet from Teterboro to Palm Beach on April 15 for 4 passengers. Budget around $30,000.",

  /** Email format with signature, multi-line. */
  emailFormat: `Hi there,

I'd like to charter a flight from Chicago to Aspen on May 1st for 6 people.
We'll have ski gear. Looking to spend $25k-$35k.

Best,
Sarah Johnson
sarah@johnson.com`,

  /** Ambiguous airport — "NY" and "South Florida" need resolution. */
  ambiguousAirport: "Need to fly from NY to South Florida on April 20, 3 passengers",

  /** Missing budget — should qualify but flag budget as missing. */
  missingBudget: "Charter from KTEB to KPBI on April 10 for 5 passengers",

  /** Has departure but not arrival. */
  partialRoute: "I need to fly somewhere warm from Teterboro next Friday for 2",

  /** SMS shorthand. */
  smsShorthand: "4 from chicago to miami fri round trip",

  /** Vague / insufficient — should fail qualification. */
  vagueRequest: "What would it cost to fly somewhere nice?",

  /** Complex with pets and special requirements. */
  complexRequest: "Round trip from Van Nuys to Cabo for 6 passengers on June 1st, returning June 5th. We're bringing 2 dogs and golf clubs. Heavy jet preferred. Budget up to $80,000.",

  /** Repeat client referencing prior trip. */
  repeatClientRequest: "Hey it's John Smith again, same route as before but on May 10 for 4 passengers. Budget $30k.",
};

// ── Airport Resolution ───────────────────────────────────────────────────

describe("resolveIcao", () => {
  it("passes through valid ICAO codes", () => {
    expect(resolveIcao("KTEB")).toBe("KTEB");
    expect(resolveIcao("KPBI")).toBe("KPBI");
    expect(resolveIcao("MMSD")).toBe("MMSD");
  });

  it("resolves common city names", () => {
    expect(resolveIcao("Teterboro")).toBe("KTEB");
    expect(resolveIcao("Palm Beach")).toBe("KPBI");
    expect(resolveIcao("Aspen")).toBe("KASE");
    expect(resolveIcao("Chicago")).toBe("KORD");
  });

  it("resolves metro area shorthand", () => {
    expect(resolveIcao("NY")).toBe("KTEB");
    expect(resolveIcao("NYC")).toBe("KTEB");
    expect(resolveIcao("New York")).toBe("KTEB");
    expect(resolveIcao("LA")).toBe("KVNY");
    expect(resolveIcao("South Florida")).toBe("KPBI");
  });

  it("handles 'airport' and 'international' suffixes", () => {
    expect(resolveIcao("Miami International Airport")).toBe("KMIA");
    expect(resolveIcao("Las Vegas Airport")).toBe("KLAS");
  });

  it("returns null for unresolvable input", () => {
    expect(resolveIcao("")).toBeNull();
    expect(resolveIcao("Atlantis")).toBeNull();
  });

  it("resolves international destinations", () => {
    expect(resolveIcao("Cabo")).toBe("MMSD");
    expect(resolveIcao("Nassau")).toBe("MYNN");
    expect(resolveIcao("Bermuda")).toBe("TXKF");
  });
});

// ── Passenger Extraction ─────────────────────────────────────────────────

describe("extractPax", () => {
  it("extracts 'N passengers'", () => {
    expect(extractPax("for 4 passengers")).toBe(4);
    expect(extractPax("6 people")).toBe(6);
    expect(extractPax("3 pax")).toBe(3);
  });

  it("extracts 'party of N'", () => {
    expect(extractPax("party of 8")).toBe(8);
  });

  it("handles couples", () => {
    expect(extractPax("2 couples")).toBe(4);
  });

  it("handles 'me and my wife'", () => {
    expect(extractPax("me and my wife")).toBe(2);
    expect(extractPax("me and my wife plus 3 kids")).toBe(5);
  });

  it("returns null when no pax mentioned", () => {
    expect(extractPax("fly from NY to LA")).toBeNull();
  });
});

// ── Budget Extraction ────────────────────────────────────────────────────

describe("extractBudget", () => {
  it("extracts dollar range '$25k-$35k'", () => {
    const budget = extractBudget("Looking to spend $25k-$35k");
    expect(budget).not.toBeNull();
    expect(budget!.min).toBe(25000);
    expect(budget!.max).toBe(35000);
  });

  it("extracts 'around $30,000'", () => {
    const budget = extractBudget("Budget around $30,000");
    expect(budget).not.toBeNull();
    expect(budget!.min).toBe(25500); // 30000 * 0.85
    expect(budget!.max).toBe(34500); // 30000 * 1.15
  });

  it("extracts 'up to $80,000'", () => {
    const budget = extractBudget("Budget up to $80,000");
    expect(budget).not.toBeNull();
    expect(budget!.min).toBe(0);
    expect(budget!.max).toBe(80000);
  });

  it("returns null when no budget mentioned", () => {
    expect(extractBudget("fly from NY to LA")).toBeNull();
  });

  it("handles comma-separated amounts", () => {
    const budget = extractBudget("budget of $25,000");
    expect(budget).not.toBeNull();
    expect(budget!.min).toBeGreaterThan(20000);
    expect(budget!.max).toBeLessThan(30000);
  });
});

// ── Date Extraction ──────────────────────────────────────────────────────

describe("extractDate", () => {
  it("extracts ISO date", () => {
    expect(extractDate("flight on 2026-04-15")).toBe("2026-04-15");
  });

  it("extracts 'Month DD' format", () => {
    expect(extractDate("on April 15", TODAY)).toBe("2026-04-15");
    expect(extractDate("May 1st trip", TODAY)).toBe("2026-05-01");
  });

  it("extracts 'MM/DD' format", () => {
    expect(extractDate("depart 4/15", TODAY)).toBe("2026-04-15");
    expect(extractDate("on 04/15/2026")).toBe("2026-04-15");
  });

  it("handles 'tomorrow'", () => {
    const result = extractDate("need a flight tomorrow", TODAY);
    expect(result).toBe("2026-04-01");
  });

  it("handles 'next Friday'", () => {
    const result = extractDate("next Friday", TODAY);
    // March 31, 2026 is a Tuesday, so "next Friday" = April 10 (next week's Friday)
    expect(result).toBeDefined();
    // Parse as local date components to avoid UTC timezone shift
    const [y, m, day] = result!.split("-").map(Number);
    const d = new Date(y!, m! - 1, day);
    expect(d.getDay()).toBe(5); // Friday
  });

  it("returns null when no date found", () => {
    expect(extractDate("fly from NY to LA")).toBeNull();
  });
});

// ── Aircraft Class Extraction ────────────────────────────────────────────

describe("extractAircraftClass", () => {
  it("extracts explicit class mentions", () => {
    expect(extractAircraftClass("light jet")).toBe("light");
    expect(extractAircraftClass("midsize cabin")).toBe("midsize");
    expect(extractAircraftClass("super mid")).toBe("super_mid");
    expect(extractAircraftClass("heavy jet")).toBe("heavy");
  });

  it("infers from specific aircraft types", () => {
    expect(extractAircraftClass("Phenom 300")).toBe("light");
    expect(extractAircraftClass("G550")).toBe("heavy");
    expect(extractAircraftClass("Challenger 300")).toBe("super_mid");
  });

  it("infers from comfort hints", () => {
    expect(extractAircraftClass("need a spacious cabin")).toBe("heavy");
  });

  it("returns null when no class mentioned", () => {
    expect(extractAircraftClass("fly from NY to LA")).toBeNull();
  });
});

// ── Route Extraction ─────────────────────────────────────────────────────

describe("extractRoute", () => {
  it("extracts 'from X to Y'", () => {
    const [dep, arr] = extractRoute("from Teterboro to Palm Beach on April 15");
    expect(dep).toBe("KTEB");
    expect(arr).toBe("KPBI");
  });

  it("extracts 'X to Y' without 'from'", () => {
    const [dep, arr] = extractRoute("Chicago to Aspen on May 1");
    expect(dep).toBe("KORD");
    expect(arr).toBe("KASE");
  });

  it("extracts ICAO codes directly", () => {
    const [dep, arr] = extractRoute("KTEB to KPBI on April 10");
    expect(dep).toBe("KTEB");
    expect(arr).toBe("KPBI");
  });

  it("handles metro area names", () => {
    const [dep, arr] = extractRoute("NY to South Florida next week");
    expect(dep).toBe("KTEB");
    expect(arr).toBe("KPBI");
  });

  it("returns nulls when route not parseable", () => {
    const [dep, arr] = extractRoute("I want to fly somewhere");
    expect(dep).toBeNull();
    expect(arr).toBeNull();
  });
});

// ── Client Info Extraction ───────────────────────────────────────────────

describe("extractClientName", () => {
  it("extracts 'this is [Name]'", () => {
    expect(extractClientName("Hi, this is John Smith")).toBe("John Smith");
  });

  it("extracts email signature", () => {
    expect(extractClientName("Please confirm.\n\nBest,\nSarah Johnson")).toBe("Sarah Johnson");
  });

  it("returns null when no name found", () => {
    expect(extractClientName("I need a flight")).toBeNull();
  });
});

describe("extractContact", () => {
  it("extracts email address", () => {
    expect(extractContact("reach me at john@example.com")).toBe("john@example.com");
  });

  it("extracts phone number", () => {
    expect(extractContact("call me at (555) 123-4567")).toBe("(555) 123-4567");
  });

  it("returns null when no contact found", () => {
    expect(extractContact("I need a flight")).toBeNull();
  });
});

// ── Special Requirements ─────────────────────────────────────────────────

describe("extractSpecialRequirements", () => {
  it("extracts pets", () => {
    expect(extractSpecialRequirements("bringing 2 dogs")).toContain("pets");
  });

  it("extracts ski gear", () => {
    expect(extractSpecialRequirements("have ski gear")).toContain("ski_gear");
  });

  it("extracts multiple requirements", () => {
    const reqs = extractSpecialRequirements("bringing golf clubs and a dog");
    expect(reqs).toContain("golf_clubs");
    expect(reqs).toContain("pets");
  });

  it("returns empty array when none found", () => {
    expect(extractSpecialRequirements("fly from NY to LA")).toHaveLength(0);
  });
});

describe("isRoundTrip", () => {
  it("detects round trip", () => {
    expect(isRoundTrip("round trip from NY to LA")).toBe(true);
    expect(isRoundTrip("return flight to Miami")).toBe(true);
  });

  it("one-way by default", () => {
    expect(isRoundTrip("from NY to LA")).toBe(false);
  });
});

// ── Full Code-Layer Parser ───────────────────────────────────────────────

describe("parseRequestText", () => {
  it("parses clean text request with all fields", () => {
    const parsed = parseRequestText(FIXTURES.cleanText, TODAY);

    expect(parsed.departure).toBe("KTEB");
    expect(parsed.arrival).toBe("KPBI");
    expect(parsed.date).toBe("2026-04-15");
    expect(parsed.pax).toBe(4);
    expect(parsed.aircraftClass).toBe("light");
    expect(parsed.budget).not.toBeNull();
    expect(parsed.budget!.min).toBeGreaterThan(20000);
    expect(parsed.budget!.max).toBeLessThan(40000);
    expect(parsed.isRoundTrip).toBe(false);
  });

  it("parses email format with signature and contact", () => {
    const parsed = parseRequestText(FIXTURES.emailFormat, TODAY);

    expect(parsed.departure).toBe("KORD");  // Chicago
    expect(parsed.arrival).toBe("KASE");    // Aspen
    expect(parsed.date).toBe("2026-05-01");
    expect(parsed.pax).toBe(6);
    expect(parsed.specialRequirements).toContain("ski_gear");
    expect(parsed.clientName).toBe("Sarah Johnson");
    expect(parsed.clientContact).toBe("sarah@johnson.com");
    expect(parsed.budget).not.toBeNull();
    expect(parsed.budget!.min).toBe(25000);
    expect(parsed.budget!.max).toBe(35000);
  });

  it("resolves ambiguous airports", () => {
    const parsed = parseRequestText(FIXTURES.ambiguousAirport, TODAY);

    expect(parsed.departure).toBe("KTEB");  // "NY" → Teterboro
    expect(parsed.arrival).toBe("KPBI");    // "South Florida" → Palm Beach
  });

  it("parses request with missing budget", () => {
    const parsed = parseRequestText(FIXTURES.missingBudget, TODAY);

    expect(parsed.departure).toBe("KTEB");
    expect(parsed.arrival).toBe("KPBI");
    expect(parsed.pax).toBe(5);
    expect(parsed.budget).toBeNull();
  });

  it("parses complex request with special requirements", () => {
    const parsed = parseRequestText(FIXTURES.complexRequest, TODAY);

    expect(parsed.departure).toBe("KVNY");  // Van Nuys
    expect(parsed.arrival).toBe("MMSD");    // Cabo
    expect(parsed.pax).toBe(6);
    expect(parsed.isRoundTrip).toBe(true);
    expect(parsed.specialRequirements).toContain("pets");
    expect(parsed.specialRequirements).toContain("golf_clubs");
    expect(parsed.aircraftClass).toBe("heavy");
    expect(parsed.budget).not.toBeNull();
    expect(parsed.budget!.max).toBe(80000);
  });

  it("parses SMS shorthand", () => {
    const parsed = parseRequestText(FIXTURES.smsShorthand, TODAY);

    expect(parsed.departure).toBe("KORD");  // chicago
    expect(parsed.arrival).toBe("KMIA");    // miami
    expect(parsed.isRoundTrip).toBe(true);
  });
});

// ── Qualification Logic ──────────────────────────────────────────────────

describe("qualify", () => {
  it("qualifies fully complete request", () => {
    const parsed = parseRequestText(FIXTURES.cleanText, TODAY);
    const result = qualify(parsed);
    expect(result.qualified).toBe(true);
    expect(result.budgetMissing).toBe(false);
    expect(result.reason).toContain("Fully qualified");
  });

  it("qualifies request missing budget but flags it", () => {
    const parsed = parseRequestText(FIXTURES.missingBudget, TODAY);
    const result = qualify(parsed);
    expect(result.qualified).toBe(true);
    expect(result.budgetMissing).toBe(true);
    expect(result.reason).toContain("Awaiting budget");
  });

  it("rejects when no route found", () => {
    const parsed = parseRequestText(FIXTURES.vagueRequest, TODAY);
    const result = qualify(parsed);
    expect(result.qualified).toBe(false);
    expect(result.reason).toContain("No valid route");
  });

  it("rejects when no date", () => {
    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: "KPBI", date: null, pax: 4,
      aircraftClass: null, budget: null, isRoundTrip: false,
      specialRequirements: [], clientName: null, clientContact: null,
    };
    const result = qualify(parsed);
    expect(result.qualified).toBe(false);
    expect(result.reason).toContain("date");
  });

  it("rejects when no pax", () => {
    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: null,
      aircraftClass: null, budget: null, isRoundTrip: false,
      specialRequirements: [], clientName: null, clientContact: null,
    };
    const result = qualify(parsed);
    expect(result.qualified).toBe(false);
    expect(result.reason).toContain("passenger");
  });

  it("qualifies with only departure (one end of route sufficient)", () => {
    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: null, date: "2026-04-15", pax: 4,
      aircraftClass: null, budget: { min: 20000, max: 40000 }, isRoundTrip: false,
      specialRequirements: [], clientName: null, clientContact: null,
    };
    const result = qualify(parsed);
    expect(result.qualified).toBe(true);
  });
});

// ── Repeat Client Detection ──────────────────────────────────────────────

describe("detectRepeatClient", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dumont-test-"));
    storePath = join(tmpDir, "deals.json");
  });

  function makeRecord(overrides: Partial<DealRecord> = {}): DealRecord {
    return {
      id: "deal_001",
      timestamp: "2026-03-15T10:00:00.000Z",
      mode: "live",
      route: { departure: "KTEB", arrival: "KPBI", distance: 950 },
      aviapagesEstimate: { low: 25000, high: 35000 },
      operatorQuote: 28000,
      osaPrice: 30400,
      estimateDelta: -0.07,
      operatorName: "Elite Aviation",
      operatorBase: "KTEB",
      operatorResponseTime: 3600,
      operatorConversion: true,
      aircraftType: "Phenom 300E",
      aircraftClass: "light",
      clientName: "John Smith",
      clientContact: "john@smith.com",
      clientType: "new",
      clientBudget: { min: 25000, max: 35000 },
      clientConversion: true,
      decisionTime: 1800,
      result: "closed",
      revenue: 2400,
      margin: 0.08,
      totalDealTime: 7200,
      dayOfWeek: 2,
      season: "shoulder",
      guardianFlags: [],
      ...overrides,
    };
  }

  it("detects repeat client by name", () => {
    const records = [makeRecord()];
    writeFileSync(storePath, JSON.stringify(records));
    const store = new DealStore(storePath);

    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: "KPBI", date: "2026-05-10", pax: 4,
      aircraftClass: null, budget: null, isRoundTrip: false,
      specialRequirements: [], clientName: "John Smith", clientContact: null,
    };

    const result = detectRepeatClient(parsed, store);
    expect(result.isRepeat).toBe(true);
    expect(result.previousDealCount).toBe(1);
    expect(result.lastAircraftClass).toBe("light");
    expect(result.lastBudget).toEqual({ min: 25000, max: 35000 });

    rmSync(tmpDir, { recursive: true });
  });

  it("detects repeat client by email", () => {
    const records = [makeRecord()];
    writeFileSync(storePath, JSON.stringify(records));
    const store = new DealStore(storePath);

    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: "KPBI", date: "2026-05-10", pax: 4,
      aircraftClass: null, budget: null, isRoundTrip: false,
      specialRequirements: [], clientName: null, clientContact: "john@smith.com",
    };

    const result = detectRepeatClient(parsed, store);
    expect(result.isRepeat).toBe(true);

    rmSync(tmpDir, { recursive: true });
  });

  it("returns not-repeat for unknown client", () => {
    const records = [makeRecord()];
    writeFileSync(storePath, JSON.stringify(records));
    const store = new DealStore(storePath);

    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: "KPBI", date: "2026-05-10", pax: 4,
      aircraftClass: null, budget: null, isRoundTrip: false,
      specialRequirements: [], clientName: "Jane Doe", clientContact: null,
    };

    const result = detectRepeatClient(parsed, store);
    expect(result.isRepeat).toBe(false);
    expect(result.previousDealCount).toBe(0);

    rmSync(tmpDir, { recursive: true });
  });

  it("returns not-repeat when no deal store", () => {
    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: "KPBI", date: "2026-05-10", pax: 4,
      aircraftClass: null, budget: null, isRoundTrip: false,
      specialRequirements: [], clientName: "John Smith", clientContact: null,
    };

    const result = detectRepeatClient(parsed, null);
    expect(result.isRepeat).toBe(false);
  });

  it("returns most recent deal data for repeat client", () => {
    const records = [
      makeRecord({ id: "deal_001", timestamp: "2026-02-01T10:00:00.000Z", aircraftClass: "light", clientBudget: { min: 20000, max: 30000 } }),
      makeRecord({ id: "deal_002", timestamp: "2026-03-15T10:00:00.000Z", aircraftClass: "midsize", clientBudget: { min: 30000, max: 45000 } }),
    ];
    writeFileSync(storePath, JSON.stringify(records));
    const store = new DealStore(storePath);

    const parsed: ParsedRequest = {
      departure: "KTEB", arrival: "KPBI", date: "2026-05-10", pax: 4,
      aircraftClass: null, budget: null, isRoundTrip: false,
      specialRequirements: [], clientName: "John Smith", clientContact: null,
    };

    const result = detectRepeatClient(parsed, store);
    expect(result.isRepeat).toBe(true);
    expect(result.previousDealCount).toBe(2);
    expect(result.lastAircraftClass).toBe("midsize"); // from the more recent deal
    expect(result.lastBudget).toEqual({ min: 30000, max: 45000 });

    rmSync(tmpDir, { recursive: true });
  });
});

// ── Full Intake Capability ───────────────────────────────────────────────

describe("intake (full capability)", () => {
  beforeEach(() => _resetDealCounter());

  it("parses clean text request and qualifies", async () => {
    const ctx = createDealContext("sim");
    const result = await intake(FIXTURES.cleanText, ctx, { today: TODAY });

    expect(result.client.qualified).toBe(true);
    expect(result.client.type).toBe("new");
    expect(result.trip.departure).toBe("KTEB");
    expect(result.trip.arrival).toBe("KPBI");
    expect(result.trip.date).toBe("2026-04-15");
    expect(result.trip.pax).toBe(4);
    expect(result.trip.aircraftClass).toBe("light");
    expect(result.client.budget).not.toBeNull();
  });

  it("parses email format with client info", async () => {
    const ctx = createDealContext("sim");
    const result = await intake(FIXTURES.emailFormat, ctx, { today: TODAY });

    expect(result.client.qualified).toBe(true);
    expect(result.client.name).toBe("Sarah Johnson");
    expect(result.client.contact).toBe("sarah@johnson.com");
    expect(result.trip.departure).toBe("KORD");
    expect(result.trip.arrival).toBe("KASE");
    expect(result.trip.specialRequirements).toContain("ski_gear");
  });

  it("resolves ambiguous airports", async () => {
    const ctx = createDealContext("sim");
    const result = await intake(FIXTURES.ambiguousAirport, ctx, { today: TODAY });

    expect(result.trip.departure).toBe("KTEB");  // NY → Teterboro
    expect(result.trip.arrival).toBe("KPBI");    // South Florida → Palm Beach
  });

  it("qualifies but leaves budget null when not provided", async () => {
    const ctx = createDealContext("sim");
    const result = await intake(FIXTURES.missingBudget, ctx, { today: TODAY });

    expect(result.client.qualified).toBe(true);
    expect(result.client.budget).toBeNull();
    expect(result.client.qualificationReason).toContain("Awaiting budget");
  });

  it("detects repeat client and pre-populates from memory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "dumont-test-"));
    const storePath = join(tmpDir, "deals.json");

    const records: DealRecord[] = [{
      id: "deal_001",
      timestamp: "2026-03-15T10:00:00.000Z",
      mode: "live",
      route: { departure: "KTEB", arrival: "KPBI", distance: 950 },
      aviapagesEstimate: { low: 25000, high: 35000 },
      operatorQuote: 28000,
      osaPrice: 30400,
      estimateDelta: -0.07,
      operatorName: "Elite Aviation",
      operatorBase: "KTEB",
      operatorResponseTime: 3600,
      operatorConversion: true,
      aircraftType: "Phenom 300E",
      aircraftClass: "light",
      clientName: "John Smith",
      clientContact: "john@smith.com",
      clientType: "new",
      clientBudget: { min: 25000, max: 35000 },
      clientConversion: true,
      decisionTime: 1800,
      result: "closed",
      revenue: 2400,
      margin: 0.08,
      totalDealTime: 7200,
      dayOfWeek: 2,
      season: "shoulder",
      guardianFlags: [],
    }];
    writeFileSync(storePath, JSON.stringify(records));
    const store = new DealStore(storePath);

    const ctx = createDealContext("sim");
    const result = await intake(FIXTURES.repeatClientRequest, ctx, {
      today: TODAY,
      dealStore: store,
    });

    expect(result.client.type).toBe("repeat");
    expect(result.client.name).toBe("John Smith");
    // Budget comes from the request text ($30k)
    expect(result.client.budget).not.toBeNull();

    rmSync(tmpDir, { recursive: true });
  });

  it("fails qualification for vague request", async () => {
    const ctx = createDealContext("sim");
    const result = await intake(FIXTURES.vagueRequest, ctx, { today: TODAY });

    expect(result.client.qualified).toBe(false);
    expect(result.client.qualificationReason).toContain("No valid route");
  });

  it("uses LLM fallback when code-layer misses critical fields", async () => {
    const ctx = createDealContext("sim");

    // Mock LLM that fills in what code-layer missed
    const mockLlm = async (_raw: string) => ({
      departure_icao: "KTEB",
      arrival_icao: "KPBI",
      departure_city: "New York",
      arrival_city: "Palm Beach",
      date: "2026-04-15",
      pax: 3,
      aircraft_class: null as "light" | "midsize" | "super_mid" | "heavy" | "ultra_long_range" | null,
      budget_min: null,
      budget_max: null,
      is_round_trip: false,
      special_requirements: [] as string[],
      client_name: null,
      client_contact: null,
    });

    // Use a hard-to-parse request that the code layer will partially fail on
    const result = await intake(
      "I'd like to explore options for getting to Florida from the northeast mid-April, there'll be 3 of us",
      ctx,
      { today: TODAY, llmParser: mockLlm },
    );

    // LLM should have filled in departure/arrival/date/pax
    expect(result.trip.departure).toBe("KTEB");
    expect(result.trip.arrival).toBe("KPBI");
    expect(result.trip.pax).toBe(3);
  });

  it("handles complex request with all special requirements", async () => {
    const ctx = createDealContext("sim");
    const result = await intake(FIXTURES.complexRequest, ctx, { today: TODAY });

    expect(result.trip.departure).toBe("KVNY");
    expect(result.trip.arrival).toBe("MMSD");
    expect(result.trip.isRoundTrip).toBe(true);
    expect(result.trip.specialRequirements).toContain("pets");
    expect(result.trip.specialRequirements).toContain("golf_clubs");
    expect(result.trip.aircraftClass).toBe("heavy");
    expect(result.client.budget!.max).toBe(80000);
  });
});
