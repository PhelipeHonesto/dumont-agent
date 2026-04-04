/**
 * Tests for Learning Loop — deal recording, closeDeal(), and DealStore
 * query verification.
 *
 * Coverage:
 * 1. Successful close with all fields populated
 * 2. Failed deal recording (budget mismatch, client declined, etc.)
 * 3. Estimate delta calculation persisted correctly
 * 4. DealStore queries after recording: getByRoute, getOperatorStats, getPricingDelta
 * 5. closeDeal() orchestrator function: stage transitions, hooks, outcome section
 * 6. Edge cases: missing data, season detection, guardian flags
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildDealRecord,
  recordDeal,
  detectSeason,
  computeRouteDistance,
} from "../src/memory/learning-loop.js";
import type { AirportCoords } from "../src/memory/learning-loop.js";
import { DealStore } from "../src/memory/deal-store.js";
import { closeDeal } from "../src/orchestrator/index.js";
import type { PipelineResult, PipelineHooks } from "../src/orchestrator/index.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import { advanceStage } from "../src/orchestrator/stage-transitions.js";
import type { DealContext } from "../src/schemas/deal-context.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Fixtures ──────────────────────────────────────────────────────────────

const AIRPORTS: Map<string, AirportCoords> = new Map([
  ["KTEB", { icao: "KTEB", latitude: 40.8501, longitude: -74.0608 }],
  ["KPBI", { icao: "KPBI", latitude: 26.6832, longitude: -80.0956 }],
]);

function makeStore(): { store: DealStore; path: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "dumont-loop-test-"));
  const storePath = join(tmpDir, "deals.json");
  writeFileSync(storePath, "[]");
  return { store: new DealStore(storePath), path: storePath, cleanup: () => rmSync(tmpDir, { recursive: true }) };
}

function makeClosedDealCtx(): DealContext {
  const ctx = createDealContext("live");
  updateDealContext(ctx, {
    trip: {
      departure: "KTEB", arrival: "KPBI", date: "2026-04-15",
      pax: 4, aircraftClass: "light", aircraftType: "Phenom 300E",
      isRoundTrip: false, specialRequirements: ["pets"],
    },
    client: {
      name: "John Smith", contact: "john@smith.com", type: "new",
      budget: { min: 25000, max: 40000 }, substitutionPref: null,
      qualified: true, qualificationReason: "Fully qualified",
    },
    estimate: {
      source: "aviapages",
      flightTime: 150,
      priceRange: { low: 25000, high: 35000 },
      fuelBurn: 280,
      positioning: null,
      calculatedAt: new Date().toISOString(),
    },
    sourcing: {
      selectedOperator: {
        operatorId: "op_001", operatorName: "Elite Aviation",
        phone: "+1-555-0100", baseAirport: "KTEB",
        aircraftType: "Phenom 300E", aircraftTail: "N300EA",
        score: 0.85,
        scoreBreakdown: { proximity: 0.9, laneHistory: 0.7, responseTime: 0.8, pricingAccuracy: 0.85, relationship: 0.8 },
        distanceToDeparture: 0,
      },
      backupOperator: null,
      rankingReason: "Elite Aviation selected",
      laneHistory: [],
    },
    quote: {
      operatorPrice: 28000,
      osaPrice: 30435,
      margin: 0.08,
      validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
      aircraft: { type: "Phenom 300E", tail: "N300EA", year: 2022 },
      quotedAt: new Date().toISOString(),
    },
    presentation: {
      sentAt: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min ago
      viewedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      clientDecision: null,
      decisionAt: null,
      timerStarted: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
  });
  // Advance to presented stage
  advanceStage(ctx, "qualified");
  advanceStage(ctx, "estimated");
  advanceStage(ctx, "sourced");
  advanceStage(ctx, "quoted");
  advanceStage(ctx, "presented");
  return ctx;
}

function makeFailedDealCtx(): DealContext {
  const ctx = createDealContext("sim");
  updateDealContext(ctx, {
    trip: {
      departure: "KTEB", arrival: "KPBI", date: "2026-04-15",
      pax: 4, aircraftClass: "light", aircraftType: null,
      isRoundTrip: false, specialRequirements: [],
    },
    client: {
      name: "Jane Doe", contact: "jane@doe.com", type: "new",
      budget: { min: 10000, max: 15000 }, substitutionPref: null,
      qualified: true, qualificationReason: "Qualified",
    },
    estimate: {
      source: "aviapages",
      flightTime: 150,
      priceRange: { low: 25000, high: 35000 },
      fuelBurn: 280,
      positioning: null,
      calculatedAt: new Date().toISOString(),
    },
  });
  advanceStage(ctx, "qualified");
  advanceStage(ctx, "estimated");
  return ctx;
}

// ── Season Detection ──────────────────────────────────────────────────────

describe("detectSeason", () => {
  it("returns peak for December 15-31", () => {
    expect(detectSeason("2026-12-20")).toBe("peak");
    expect(detectSeason("2026-12-15")).toBe("peak");
    expect(detectSeason("2026-12-31")).toBe("peak");
  });

  it("returns peak for Jan 1-5", () => {
    expect(detectSeason("2026-01-01")).toBe("peak");
    expect(detectSeason("2026-01-05")).toBe("peak");
  });

  it("returns peak for February and March", () => {
    expect(detectSeason("2026-02-15")).toBe("peak");
    expect(detectSeason("2026-03-20")).toBe("peak");
  });

  it("returns shoulder for October and November", () => {
    expect(detectSeason("2026-10-15")).toBe("shoulder");
    expect(detectSeason("2026-11-20")).toBe("shoulder");
  });

  it("returns shoulder for May and June", () => {
    expect(detectSeason("2026-05-15")).toBe("shoulder");
    expect(detectSeason("2026-06-20")).toBe("shoulder");
  });

  it("returns off for July-September", () => {
    expect(detectSeason("2026-07-15")).toBe("off");
    expect(detectSeason("2026-08-15")).toBe("off");
    expect(detectSeason("2026-09-15")).toBe("off");
  });

  it("returns off for Jan 6-31", () => {
    expect(detectSeason("2026-01-06")).toBe("off");
    expect(detectSeason("2026-01-31")).toBe("off");
  });

  it("returns off for empty date", () => {
    expect(detectSeason("")).toBe("off");
  });
});

// ── computeRouteDistance ──────────────────────────────────────────────────

describe("computeRouteDistance", () => {
  it("computes distance between KTEB and KPBI", () => {
    const dist = computeRouteDistance("KTEB", "KPBI", AIRPORTS);
    expect(dist).toBeGreaterThan(900);
    expect(dist).toBeLessThan(1000);
  });

  it("returns 0 when no airports provided", () => {
    expect(computeRouteDistance("KTEB", "KPBI")).toBe(0);
  });

  it("returns 0 when airport not in map", () => {
    expect(computeRouteDistance("KTEB", "KZZZ", AIRPORTS)).toBe(0);
  });
});

// ── buildDealRecord ──────────────────────────────────────────────────────

describe("buildDealRecord", () => {
  beforeEach(() => _resetDealCounter());

  it("builds record with all fields from closed deal", () => {
    const ctx = makeClosedDealCtx();
    ctx.presentation.decisionAt = new Date().toISOString();

    const record = buildDealRecord(ctx, {
      result: "closed",
      operatorResponseTime: 1800,
      airports: AIRPORTS,
    });

    // Identity
    expect(record.id).toBe(ctx.id);
    expect(record.mode).toBe("live");
    expect(record.timestamp).toBeDefined();

    // Route
    expect(record.route.departure).toBe("KTEB");
    expect(record.route.arrival).toBe("KPBI");
    expect(record.route.distance).toBeGreaterThan(900);

    // Pricing
    expect(record.aviapagesEstimate).toEqual({ low: 25000, high: 35000 });
    expect(record.operatorQuote).toBe(28000);
    expect(record.osaPrice).toBe(30435);
    // estimateDelta: (28000 - 30000) / 30000 = -0.0667
    expect(record.estimateDelta).not.toBeNull();
    expect(record.estimateDelta!).toBeCloseTo(-0.0667, 3);

    // Operator
    expect(record.operatorName).toBe("Elite Aviation");
    expect(record.operatorBase).toBe("KTEB");
    expect(record.operatorResponseTime).toBe(1800);
    expect(record.operatorConversion).toBe(true);

    // Aircraft
    expect(record.aircraftType).toBe("Phenom 300E");
    expect(record.aircraftClass).toBe("light");

    // Client
    expect(record.clientName).toBe("John Smith");
    expect(record.clientContact).toBe("john@smith.com");
    expect(record.clientType).toBe("new");
    expect(record.clientBudget).toEqual({ min: 25000, max: 40000 });
    expect(record.clientConversion).toBe(true);
    expect(record.decisionTime).not.toBeNull();

    // Outcome
    expect(record.result).toBe("closed");
    expect(record.revenue).toBe(30435 - 28000);
    expect(record.margin).toBe(0.08);

    // Timing (may be 0 in tests since ctx was just created)
    expect(record.totalDealTime).toBeGreaterThanOrEqual(0);
    expect(record.dayOfWeek).toBeGreaterThanOrEqual(0);
    expect(record.dayOfWeek).toBeLessThanOrEqual(6);
    expect(["peak", "shoulder", "off"]).toContain(record.season);

    // Meta
    expect(Array.isArray(record.guardianFlags)).toBe(true);
  });

  it("builds record for failed deal (budget mismatch)", () => {
    const ctx = makeFailedDealCtx();
    const record = buildDealRecord(ctx, { result: "budget_mismatch" });

    expect(record.result).toBe("budget_mismatch");
    expect(record.clientConversion).toBe(false);
    expect(record.operatorConversion).toBe(false); // no operator quote
    expect(record.revenue).toBeNull();
    expect(record.operatorName).toBeNull();
    expect(record.operatorBase).toBeNull();
  });

  it("builds record for client_declined deal", () => {
    const ctx = makeClosedDealCtx();
    const record = buildDealRecord(ctx, { result: "client_declined" });

    expect(record.result).toBe("client_declined");
    expect(record.clientConversion).toBe(false);
    expect(record.operatorConversion).toBe(true); // operator did quote
    expect(record.revenue).toBeNull(); // no revenue on decline
  });

  it("computes null estimateDelta when no estimate", () => {
    const ctx = makeClosedDealCtx();
    updateDealContext(ctx, { estimate: { priceRange: null } });

    const record = buildDealRecord(ctx, { result: "closed" });
    expect(record.estimateDelta).toBeNull();
  });

  it("computes null estimateDelta when no operator quote", () => {
    const ctx = makeFailedDealCtx();
    const record = buildDealRecord(ctx, { result: "operator_no_response" });
    expect(record.estimateDelta).toBeNull();
  });

  it("collects guardian warning/critical flags", () => {
    const ctx = makeClosedDealCtx();
    ctx.guardian.passes.push({
      stage: "intake",
      passed: true,
      timestamp: new Date().toISOString(),
      checks: [
        { name: "pax_capacity", passed: true, severity: "warning", message: "At maximum capacity" },
        { name: "departure", passed: true, severity: "info", message: "Departure OK" },
        { name: "range", passed: false, severity: "critical", message: "Range exceeded" },
      ],
    });

    const record = buildDealRecord(ctx, { result: "closed" });
    expect(record.guardianFlags.length).toBe(2); // warning + critical, not info
    expect(record.guardianFlags.some((f) => f.includes("pax_capacity"))).toBe(true);
    expect(record.guardianFlags.some((f) => f.includes("Range exceeded"))).toBe(true);
  });

  it("sets route departure/arrival to XXXX when missing", () => {
    const ctx = makeFailedDealCtx();
    updateDealContext(ctx, { trip: { departure: "", arrival: "" } });

    const record = buildDealRecord(ctx, { result: "budget_mismatch" });
    expect(record.route.departure).toBe("XXXX");
    expect(record.route.arrival).toBe("XXXX");
  });
});

// ── recordDeal (persist to DealStore) ────────────────────────────────────

describe("recordDeal", () => {
  beforeEach(() => _resetDealCounter());

  it("persists record to DealStore", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    const record = recordDeal(ctx, store, { result: "closed", airports: AIRPORTS });

    expect(store.count).toBe(1);
    expect(store.getAll()[0]!.id).toBe(record.id);
    cleanup();
  });

  it("updates ctx.outcome.notes when notes provided", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    recordDeal(ctx, store, { result: "closed", notes: "Smooth deal, client very happy" });

    expect(ctx.outcome.notes).toBe("Smooth deal, client very happy");
    cleanup();
  });
});

// ── closeDeal (orchestrator) ─────────────────────────────────────────────

describe("closeDeal", () => {
  beforeEach(() => _resetDealCounter());

  it("transitions to closed stage for successful deal", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store, airports: AIRPORTS });

    expect(ctx.stage).toBe("closed");
    expect(ctx.outcome.result).toBe("closed");
    expect(ctx.presentation.clientDecision).toBe("confirmed");
    cleanup();
  });

  it("transitions to failed stage for declined deal", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "client_declined", dealStore: store });

    expect(ctx.stage).toBe("failed");
    expect(ctx.outcome.result).toBe("client_declined");
    expect(ctx.presentation.clientDecision).toBe("declined");
    cleanup();
  });

  it("transitions to failed for expired deal", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "expired", dealStore: store });

    expect(ctx.stage).toBe("failed");
    expect(ctx.presentation.clientDecision).toBe("expired");
    cleanup();
  });

  it("writes record to DealStore", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    const record = closeDeal(ctx, { result: "closed", dealStore: store, airports: AIRPORTS });

    expect(store.count).toBe(1);
    expect(record.result).toBe("closed");
    expect(record.operatorQuote).toBe(28000);
    cleanup();
  });

  it("calculates revenue for closed deals", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store });

    expect(ctx.outcome.revenue).toBe(30435 - 28000);
    cleanup();
  });

  it("sets estimateVsActual from calcEstimateDelta", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store });

    // estimateDelta: (28000 - 30000) / 30000 = -0.0667
    expect(ctx.outcome.estimateVsActual).not.toBeNull();
    expect(ctx.outcome.estimateVsActual!).toBeCloseTo(-0.0667, 3);
    cleanup();
  });

  it("records operator response time", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store, operatorResponseTime: 2400 });

    expect(ctx.outcome.operatorResponseTime).toBe(2400);
    const record = store.getAll()[0]!;
    expect(record.operatorResponseTime).toBe(2400);
    cleanup();
  });

  it("sets presentation.decisionAt if not already set", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store });

    expect(ctx.presentation.decisionAt).not.toBeNull();
    cleanup();
  });

  it("computes totalDealTime if not already set", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store });

    expect(ctx.outcome.totalDealTime).toBeGreaterThanOrEqual(0);
    cleanup();
  });

  it("fires onPipelineComplete hook", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();
    let hookCalled = false;
    let hookResult: PipelineResult | null = null;

    const hooks: PipelineHooks = {
      onPipelineComplete: (result) => {
        hookCalled = true;
        hookResult = result;
      },
    };

    closeDeal(ctx, { result: "closed", dealStore: store, hooks });

    expect(hookCalled).toBe(true);
    expect(hookResult).not.toBeNull();
    expect(hookResult!.dealContext.id).toBe(ctx.id);
    cleanup();
  });

  it("records failed deals too (spec: ALWAYS log outcomes)", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeFailedDealCtx();

    closeDeal(ctx, { result: "budget_mismatch", dealStore: store });

    expect(store.count).toBe(1);
    expect(store.getAll()[0]!.result).toBe("budget_mismatch");
    expect(ctx.stage).toBe("failed");
    cleanup();
  });
});

// ── DealStore Query Verification After Recording ─────────────────────────

describe("DealStore queries after deal recording", () => {
  beforeEach(() => _resetDealCounter());

  it("getByRoute returns the recorded deal", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store, airports: AIRPORTS });

    const routeDeals = store.getByRoute("KTEB", "KPBI");
    expect(routeDeals).toHaveLength(1);
    expect(routeDeals[0]!.route.departure).toBe("KTEB");
    expect(routeDeals[0]!.route.arrival).toBe("KPBI");
    expect(routeDeals[0]!.route.distance).toBeGreaterThan(900);
    cleanup();
  });

  it("getOperatorStats returns correct stats for single deal", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();

    closeDeal(ctx, { result: "closed", dealStore: store, operatorResponseTime: 1800 });

    const stats = store.getOperatorStats("Elite Aviation", "KTEB", "KPBI");
    expect(stats).not.toBeNull();
    expect(stats!.totalDeals).toBe(1);
    expect(stats!.conversionRate).toBe(1.0); // quoted = true
    expect(stats!.avgResponseTime).toBe(1800);
    cleanup();
  });

  it("getOperatorStats aggregates across multiple deals", () => {
    const { store, cleanup } = makeStore();

    // Deal 1: closed, fast response
    const ctx1 = makeClosedDealCtx();
    closeDeal(ctx1, { result: "closed", dealStore: store, operatorResponseTime: 1200 });

    // Deal 2: also closed, slower response
    const ctx2 = makeClosedDealCtx();
    closeDeal(ctx2, { result: "closed", dealStore: store, operatorResponseTime: 3600 });

    const stats = store.getOperatorStats("Elite Aviation", "KTEB", "KPBI");
    expect(stats!.totalDeals).toBe(2);
    expect(stats!.conversionRate).toBe(1.0);
    expect(stats!.avgResponseTime).toBe(2400); // (1200 + 3600) / 2
    cleanup();
  });

  it("getPricingDelta returns average delta from recorded deals", () => {
    const { store, cleanup } = makeStore();

    // Deal 1: operator quote $28K, estimate median $30K → delta = -0.0667
    const ctx1 = makeClosedDealCtx();
    closeDeal(ctx1, { result: "closed", dealStore: store });

    // Deal 2: operator quote $33.6K → delta = +0.12
    const ctx2 = makeClosedDealCtx();
    updateDealContext(ctx2, { quote: { operatorPrice: 33600 } });
    closeDeal(ctx2, { result: "closed", dealStore: store });

    const delta = store.getPricingDelta("KTEB", "KPBI");
    expect(delta).not.toBeNull();
    // Average of -0.0667 and +0.12 = +0.0267
    expect(delta!).toBeCloseTo(0.0267, 2);
    cleanup();
  });

  it("getPricingDelta returns null for unrecorded route", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();
    closeDeal(ctx, { result: "closed", dealStore: store });

    expect(store.getPricingDelta("KORD", "KASE")).toBeNull();
    cleanup();
  });

  it("getByOperator returns all deals for an operator", () => {
    const { store, cleanup } = makeStore();

    const ctx1 = makeClosedDealCtx();
    closeDeal(ctx1, { result: "closed", dealStore: store });
    const ctx2 = makeClosedDealCtx();
    closeDeal(ctx2, { result: "client_declined", dealStore: store });

    const deals = store.getByOperator("Elite Aviation");
    expect(deals).toHaveLength(2);
    cleanup();
  });

  it("findClientDeals returns recorded deal by client name", () => {
    const { store, cleanup } = makeStore();
    const ctx = makeClosedDealCtx();
    closeDeal(ctx, { result: "closed", dealStore: store });

    const deals = store.findClientDeals("John Smith");
    expect(deals).toHaveLength(1);
    expect(deals[0]!.clientName).toBe("John Smith");
    cleanup();
  });

  it("estimate delta feeds back into future pricing corrections", () => {
    const { store, cleanup } = makeStore();

    // Record 3 deals with consistent underestimate
    for (let i = 0; i < 3; i++) {
      const ctx = makeClosedDealCtx();
      updateDealContext(ctx, { quote: { operatorPrice: 33600 } }); // +12% above median
      closeDeal(ctx, { result: "closed", dealStore: store });
    }

    // getPricingDelta should reflect the consistent +12% underestimate
    const delta = store.getPricingDelta("KTEB", "KPBI");
    expect(delta).not.toBeNull();
    expect(delta!).toBeCloseTo(0.12, 1);

    // This delta would be used by the Quote capability's estimate()
    // to adjust future Aviapages estimates upward by ~12%
    cleanup();
  });
});
