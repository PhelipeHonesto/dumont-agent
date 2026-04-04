/**
 * Tests for Sourcing capability — operator ranking and selection.
 *
 * Coverage:
 * 1. Ranked selection: composite scoring with all 5 factors
 * 2. Cold start (no history): proximity + aircraft match dominate
 * 3. Backup never equals primary
 * 4. Guardian cert validation after sourcing
 * 5. Individual scoring functions
 * 6. Edge cases: no viable operators, single operator, pax filtering
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  sourcing,
  scoreProximity,
  scoreLaneHistory,
  scoreResponseTime,
  scorePricingAccuracy,
  scoreRelationship,
  scoreOperator,
  WEIGHTS,
} from "../src/capabilities/sourcing.js";
import type { OperatorRecord, AirportCoords } from "../src/capabilities/sourcing.js";
import { checksAfterSourcing } from "../src/capabilities/guardian.js";
import type { OperatorCertData } from "../src/capabilities/guardian.js";
import { DealStore } from "../src/memory/deal-store.js";
import type { DealRecord } from "../src/schemas/deal-record.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Test Fixtures ─────────────────────────────────────────────────────────

const KTEB: AirportCoords = { icao: "KTEB", latitude: 40.8501, longitude: -74.0608 };
const KPBI: AirportCoords = { icao: "KPBI", latitude: 26.6832, longitude: -80.0956 };

function makeOperator(overrides: Partial<OperatorRecord> & { operatorId: string; operatorName: string }): OperatorRecord {
  return {
    phone: "+1-555-0100",
    baseAirport: "KTEB",
    baseLatitude: 40.8501,
    baseLongitude: -74.0608,
    aircraftType: "Phenom 300E",
    aircraftTail: "N300TE",
    aircraftCategory: "light",
    passengerCapacity: 8,
    rangeNm: 2010,
    ...overrides,
  };
}

/** Operators for multi-operator tests. */
function makeOperatorSet(): OperatorRecord[] {
  return [
    // Op A: based at KTEB (same as departure) — proximity advantage
    makeOperator({
      operatorId: "op_a", operatorName: "Alpha Aviation",
      baseAirport: "KTEB", baseLatitude: 40.8501, baseLongitude: -74.0608,
    }),
    // Op B: based at KPBI (far from KTEB departure) — proximity disadvantage
    makeOperator({
      operatorId: "op_b", operatorName: "Bravo Jets",
      baseAirport: "KPBI", baseLatitude: 26.6832, baseLongitude: -80.0956,
    }),
    // Op C: based nearby KTEB — slight proximity advantage
    makeOperator({
      operatorId: "op_c", operatorName: "Charlie Air",
      baseAirport: "KHPN", baseLatitude: 41.0670, baseLongitude: -73.7076,
    }),
  ];
}

function makeDealCtx(overrides?: { pax?: number; aircraftClass?: string | null }) {
  const ctx = createDealContext("sim");
  updateDealContext(ctx, {
    trip: {
      departure: "KTEB",
      arrival: "KPBI",
      date: "2026-04-15",
      pax: overrides?.pax ?? 4,
      aircraftClass: (overrides?.aircraftClass as any) ?? "light",
      aircraftType: "Phenom 300E",
      isRoundTrip: false,
      specialRequirements: [],
    },
    client: {
      name: "Test Client", contact: "test@example.com", type: "new",
      budget: { min: 20000, max: 40000 }, substitutionPref: null,
      qualified: true, qualificationReason: "Fully qualified",
    },
  });
  return ctx;
}

function makeStoreWithDeals(records: DealRecord[]): { store: DealStore; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), "dumont-sourcing-test-"));
  const storePath = join(tmpDir, "deals.json");
  writeFileSync(storePath, JSON.stringify(records));
  return { store: new DealStore(storePath), cleanup: () => rmSync(tmpDir, { recursive: true }) };
}

function makeDealRecord(overrides: Partial<DealRecord> = {}): DealRecord {
  return {
    id: "deal_001",
    timestamp: "2026-03-01T10:00:00.000Z",
    mode: "live",
    route: { departure: "KTEB", arrival: "KPBI", distance: 950 },
    aviapagesEstimate: { low: 25000, high: 35000 },
    operatorQuote: 30000,
    osaPrice: 32609,
    estimateDelta: 0.0,
    operatorName: "Alpha Aviation",
    operatorBase: "KTEB",
    operatorResponseTime: 1800,
    operatorConversion: true,
    aircraftType: "Phenom 300E",
    aircraftClass: "light",
    clientName: "Test",
    clientContact: "test@test.com",
    clientType: "new",
    clientBudget: { min: 25000, max: 40000 },
    clientConversion: true,
    decisionTime: 1800,
    result: "closed",
    revenue: 2609,
    margin: 0.08,
    totalDealTime: 7200,
    dayOfWeek: 2,
    season: "shoulder",
    guardianFlags: [],
    ...overrides,
  };
}

// ── Individual Scoring Functions ──────────────────────────────────────────

describe("scoreProximity", () => {
  it("returns 1.0 for same-airport base", () => {
    const op = makeOperator({ operatorId: "op", operatorName: "Test", baseLatitude: KTEB.latitude, baseLongitude: KTEB.longitude });
    expect(scoreProximity(op, KTEB)).toBe(1.0);
  });

  it("returns high score for nearby base (<150nm)", () => {
    // KHPN is ~15nm from KTEB
    const op = makeOperator({ operatorId: "op", operatorName: "Test", baseLatitude: 41.0670, baseLongitude: -73.7076 });
    const score = scoreProximity(op, KTEB);
    expect(score).toBeGreaterThanOrEqual(0.85);
  });

  it("returns low score for distant base (>500nm)", () => {
    const op = makeOperator({ operatorId: "op", operatorName: "Test", baseLatitude: KPBI.latitude, baseLongitude: KPBI.longitude });
    const score = scoreProximity(op, KTEB);
    // KTEB → KPBI is ~950nm
    expect(score).toBeLessThanOrEqual(0.30);
  });

  it("returns cold start default when no departure airport", () => {
    const op = makeOperator({ operatorId: "op", operatorName: "Test" });
    expect(scoreProximity(op, null)).toBe(0.5);
  });
});

describe("scoreLaneHistory", () => {
  it("returns cold start default with no store", () => {
    expect(scoreLaneHistory("Op", "KTEB", "KPBI", null)).toBe(0.5);
  });

  it("returns cold start default with no deals for this route", () => {
    const { store, cleanup } = makeStoreWithDeals([]);
    expect(scoreLaneHistory("Op", "KTEB", "KPBI", store)).toBe(0.5);
    cleanup();
  });

  it("returns high score for operator with high conversion rate", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeDealRecord({
        id: `deal_${i}`,
        operatorName: "Alpha Aviation",
        operatorConversion: true,
        result: "closed",
      }),
    );
    const { store, cleanup } = makeStoreWithDeals(records);
    const score = scoreLaneHistory("Alpha Aviation", "KTEB", "KPBI", store);
    expect(score).toBeGreaterThan(0.8);
    cleanup();
  });

  it("blends toward cold start with few deals", () => {
    const records = [makeDealRecord({ operatorConversion: true, result: "closed" })];
    const { store, cleanup } = makeStoreWithDeals(records);
    const score = scoreLaneHistory("Alpha Aviation", "KTEB", "KPBI", store);
    // 1 deal out of 10 needed for full confidence → mostly cold start
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(0.7);
    cleanup();
  });
});

describe("scoreResponseTime", () => {
  it("returns 1.0 for fast response (<30 min)", () => {
    const records = [makeDealRecord({ operatorResponseTime: 900 })]; // 15 min
    const { store, cleanup } = makeStoreWithDeals(records);
    expect(scoreResponseTime("Alpha Aviation", "KTEB", "KPBI", store)).toBe(1.0);
    cleanup();
  });

  it("returns lower score for slow response (>4 hours)", () => {
    const records = [makeDealRecord({ operatorResponseTime: 18000 })]; // 5 hours
    const { store, cleanup } = makeStoreWithDeals(records);
    const score = scoreResponseTime("Alpha Aviation", "KTEB", "KPBI", store);
    expect(score).toBeLessThanOrEqual(0.30);
    cleanup();
  });

  it("returns cold start default with no data", () => {
    expect(scoreResponseTime("Op", "KTEB", "KPBI", null)).toBe(0.5);
  });
});

describe("scorePricingAccuracy", () => {
  it("returns 1.0 for very accurate estimates (<5% delta)", () => {
    const records = [makeDealRecord({ estimateDelta: 0.03 })];
    const { store, cleanup } = makeStoreWithDeals(records);
    expect(scorePricingAccuracy("Alpha Aviation", "KTEB", "KPBI", store)).toBe(1.0);
    cleanup();
  });

  it("returns lower score for inaccurate estimates (>15% delta)", () => {
    const records = [makeDealRecord({ estimateDelta: 0.20 })];
    const { store, cleanup } = makeStoreWithDeals(records);
    const score = scorePricingAccuracy("Alpha Aviation", "KTEB", "KPBI", store);
    expect(score).toBeLessThanOrEqual(0.50);
    cleanup();
  });

  it("uses absolute delta (negative is also inaccurate)", () => {
    const records = [makeDealRecord({ estimateDelta: -0.20 })];
    const { store, cleanup } = makeStoreWithDeals(records);
    const score = scorePricingAccuracy("Alpha Aviation", "KTEB", "KPBI", store);
    expect(score).toBeLessThanOrEqual(0.50);
    cleanup();
  });

  it("returns cold start default with no data", () => {
    expect(scorePricingAccuracy("Op", "KTEB", "KPBI", null)).toBe(0.5);
  });
});

describe("scoreRelationship", () => {
  it("returns cold start default with no closed deals", () => {
    expect(scoreRelationship("Op", null)).toBe(0.5);
  });

  it("returns higher score with more closed deals", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeDealRecord({ id: `deal_${i}`, result: "closed" }),
    );
    const { store, cleanup } = makeStoreWithDeals(records);
    const score = scoreRelationship("Alpha Aviation", store);
    expect(score).toBeGreaterThan(0.7);
    cleanup();
  });

  it("caps at 1.0", () => {
    const records = Array.from({ length: 30 }, (_, i) =>
      makeDealRecord({ id: `deal_${i}`, result: "closed" }),
    );
    const { store, cleanup } = makeStoreWithDeals(records);
    const score = scoreRelationship("Alpha Aviation", store);
    expect(score).toBeLessThanOrEqual(1.0);
    cleanup();
  });
});

// ── Composite Scoring ────────────────────────────────────────────────────

describe("scoreOperator (composite)", () => {
  beforeEach(() => _resetDealCounter());

  it("weights sum to 1.0", () => {
    const sum = WEIGHTS.proximity + WEIGHTS.laneHistory + WEIGHTS.responseTime + WEIGHTS.pricingAccuracy + WEIGHTS.relationship;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("cold start: score dominated by proximity", () => {
    const nearby = makeOperator({
      operatorId: "op_near", operatorName: "Near Op",
      baseLatitude: KTEB.latitude, baseLongitude: KTEB.longitude,
    });
    const faraway = makeOperator({
      operatorId: "op_far", operatorName: "Far Op",
      baseLatitude: KPBI.latitude, baseLongitude: KPBI.longitude,
    });

    const nearScore = scoreOperator(nearby, KTEB, "KTEB", "KPBI", null);
    const farScore = scoreOperator(faraway, KTEB, "KTEB", "KPBI", null);

    // Both have same cold-start defaults for history factors
    // Difference should come from proximity
    expect(nearScore.score).toBeGreaterThan(farScore.score);
    expect(nearScore.breakdown.proximity).toBe(1.0);
    expect(farScore.breakdown.proximity).toBeLessThanOrEqual(0.30);

    // Non-proximity factors should be cold start default
    expect(nearScore.breakdown.laneHistory).toBe(0.5);
    expect(nearScore.breakdown.responseTime).toBe(0.5);
    expect(nearScore.breakdown.pricingAccuracy).toBe(0.5);
    expect(nearScore.breakdown.relationship).toBe(0.5);
  });

  it("history factors differentiate operators at same proximity", () => {
    const opGoodHistory = makeOperator({ operatorId: "op_good", operatorName: "Good Op" });
    const opNoHistory = makeOperator({ operatorId: "op_new", operatorName: "New Op" });

    const records = Array.from({ length: 10 }, (_, i) =>
      makeDealRecord({
        id: `deal_${i}`,
        operatorName: "Good Op",
        operatorConversion: true,
        operatorResponseTime: 1200,
        estimateDelta: 0.03,
        result: "closed",
      }),
    );
    const { store, cleanup } = makeStoreWithDeals(records);

    const goodScore = scoreOperator(opGoodHistory, KTEB, "KTEB", "KPBI", store);
    const newScore = scoreOperator(opNoHistory, KTEB, "KTEB", "KPBI", store);

    // Same proximity, but Good Op has much better history
    expect(goodScore.score).toBeGreaterThan(newScore.score);
    expect(goodScore.breakdown.laneHistory).toBeGreaterThan(newScore.breakdown.laneHistory);
    expect(goodScore.breakdown.responseTime).toBeGreaterThan(newScore.breakdown.responseTime);

    cleanup();
  });
});

// ── Full Sourcing ────────────────────────────────────────────────────────

describe("sourcing (main entry)", () => {
  beforeEach(() => _resetDealCounter());

  it("selects highest-scored operator as primary", async () => {
    const ctx = makeDealCtx();
    const result = await sourcing(ctx, {
      operators: makeOperatorSet(),
      departureAirport: KTEB,
    });

    expect(result.sourcing.selectedOperator).not.toBeNull();
    // Alpha Aviation (KTEB base) should win — closest to departure
    expect(result.sourcing.selectedOperator!.operatorName).toBe("Alpha Aviation");
    expect(result.sourcing.selectedOperator!.score).toBeGreaterThan(0);
  });

  it("selects backup as second-ranked operator", async () => {
    const ctx = makeDealCtx();
    const result = await sourcing(ctx, {
      operators: makeOperatorSet(),
      departureAirport: KTEB,
    });

    expect(result.sourcing.backupOperator).not.toBeNull();
    // Charlie Air (KHPN, ~15nm from KTEB) should be backup
    expect(result.sourcing.backupOperator!.operatorName).toBe("Charlie Air");
  });

  it("backup is NEVER the same as primary", async () => {
    const ctx = makeDealCtx();
    const operators = makeOperatorSet();

    const result = await sourcing(ctx, { operators, departureAirport: KTEB });

    if (result.sourcing.backupOperator) {
      expect(result.sourcing.backupOperator.operatorId).not.toBe(
        result.sourcing.selectedOperator!.operatorId,
      );
    }
  });

  it("returns null for both when no operators match", async () => {
    const ctx = makeDealCtx({ pax: 20 }); // no light jet seats 20
    const result = await sourcing(ctx, {
      operators: makeOperatorSet(),
      departureAirport: KTEB,
    });

    expect(result.sourcing.selectedOperator).toBeNull();
    expect(result.sourcing.backupOperator).toBeNull();
    expect(result.sourcing.rankingReason).toContain("No operators matched");
  });

  it("handles single viable operator (no backup)", async () => {
    const ctx = makeDealCtx();
    const result = await sourcing(ctx, {
      operators: [makeOperator({ operatorId: "solo", operatorName: "Solo Jet" })],
      departureAirport: KTEB,
    });

    expect(result.sourcing.selectedOperator).not.toBeNull();
    expect(result.sourcing.selectedOperator!.operatorName).toBe("Solo Jet");
    expect(result.sourcing.backupOperator).toBeNull();
  });

  it("filters by aircraft class", async () => {
    const ctx = makeDealCtx({ aircraftClass: "heavy" });
    const operators = [
      makeOperator({ operatorId: "light_op", operatorName: "Light Op", aircraftCategory: "light" }),
      makeOperator({ operatorId: "heavy_op", operatorName: "Heavy Op", aircraftCategory: "heavy", passengerCapacity: 14 }),
    ];

    const result = await sourcing(ctx, { operators, departureAirport: KTEB });

    expect(result.sourcing.selectedOperator!.operatorName).toBe("Heavy Op");
  });

  it("filters by passenger capacity", async () => {
    const ctx = makeDealCtx({ pax: 10 });
    const operators = [
      makeOperator({ operatorId: "small", operatorName: "Small Jet", passengerCapacity: 8 }),
      makeOperator({ operatorId: "big", operatorName: "Big Jet", passengerCapacity: 14, aircraftCategory: "light" }),
    ];

    const result = await sourcing(ctx, { operators, departureAirport: KTEB });

    expect(result.sourcing.selectedOperator!.operatorName).toBe("Big Jet");
  });

  it("includes lane history from DealStore", async () => {
    const records = [makeDealRecord()];
    const { store, cleanup } = makeStoreWithDeals(records);

    const ctx = makeDealCtx();
    const result = await sourcing(ctx, {
      operators: makeOperatorSet(),
      departureAirport: KTEB,
      dealStore: store,
    });

    expect(result.sourcing.laneHistory.length).toBeGreaterThan(0);
    expect(result.sourcing.laneHistory[0]!.route).toBe("KTEB-KPBI");

    cleanup();
  });

  it("populates score breakdown in operator match", async () => {
    const ctx = makeDealCtx();
    const result = await sourcing(ctx, {
      operators: makeOperatorSet(),
      departureAirport: KTEB,
    });

    const op = result.sourcing.selectedOperator!;
    expect(op.scoreBreakdown).toBeDefined();
    expect(op.scoreBreakdown.proximity).toBeGreaterThanOrEqual(0);
    expect(op.scoreBreakdown.proximity).toBeLessThanOrEqual(1);
    expect(op.scoreBreakdown.laneHistory).toBeGreaterThanOrEqual(0);
    expect(op.scoreBreakdown.responseTime).toBeGreaterThanOrEqual(0);
    expect(op.scoreBreakdown.pricingAccuracy).toBeGreaterThanOrEqual(0);
    expect(op.scoreBreakdown.relationship).toBeGreaterThanOrEqual(0);
  });
});

// ── Cold Start Behavior ──────────────────────────────────────────────────

describe("cold start (no history)", () => {
  beforeEach(() => _resetDealCounter());

  it("proximity dominates ranking with no DealStore", async () => {
    const ctx = makeDealCtx();
    const operators = [
      makeOperator({
        operatorId: "far", operatorName: "Far Op",
        baseAirport: "KPBI", baseLatitude: KPBI.latitude, baseLongitude: KPBI.longitude,
      }),
      makeOperator({
        operatorId: "near", operatorName: "Near Op",
        baseAirport: "KTEB", baseLatitude: KTEB.latitude, baseLongitude: KTEB.longitude,
      }),
    ];

    const result = await sourcing(ctx, { operators, departureAirport: KTEB, dealStore: null });

    expect(result.sourcing.selectedOperator!.operatorName).toBe("Near Op");
    expect(result.sourcing.rankingReason).toContain("Cold start");
  });

  it("all history factors default to 0.5 on cold start", async () => {
    const ctx = makeDealCtx();
    const result = await sourcing(ctx, {
      operators: [makeOperator({ operatorId: "op", operatorName: "Test Op" })],
      departureAirport: KTEB,
      dealStore: null,
    });

    const bd = result.sourcing.selectedOperator!.scoreBreakdown;
    expect(bd.laneHistory).toBe(0.5);
    expect(bd.responseTime).toBe(0.5);
    expect(bd.pricingAccuracy).toBe(0.5);
    expect(bd.relationship).toBe(0.5);
  });

  it("history tips ranking when proximity is equal", async () => {
    // Both ops at KTEB — identical proximity
    const ops = [
      makeOperator({ operatorId: "op_no_hist", operatorName: "No History Op" }),
      makeOperator({ operatorId: "op_hist", operatorName: "Proven Op" }),
    ];

    const records = Array.from({ length: 8 }, (_, i) =>
      makeDealRecord({
        id: `deal_${i}`,
        operatorName: "Proven Op",
        operatorResponseTime: 1200,
        estimateDelta: 0.02,
        operatorConversion: true,
        result: "closed",
      }),
    );
    const { store, cleanup } = makeStoreWithDeals(records);

    const ctx = makeDealCtx();
    const result = await sourcing(ctx, { operators: ops, departureAirport: KTEB, dealStore: store });

    expect(result.sourcing.selectedOperator!.operatorName).toBe("Proven Op");
    expect(result.sourcing.rankingReason).toContain("Full algorithm");

    cleanup();
  });
});

// ── Guardian Cert Validation After Sourcing ──────────────────────────────

describe("Guardian cert validation after sourcing", () => {
  beforeEach(() => _resetDealCounter());

  function makeCerts(): Map<string, OperatorCertData> {
    return new Map([
      ["op_a", { operatorId: "op_a", part135Active: true, insuranceCurrent: true, argusRating: "gold", wyvernRating: null }],
      ["op_expired", { operatorId: "op_expired", part135Active: false, insuranceCurrent: false, argusRating: null, wyvernRating: null }],
    ]);
  }

  it("Guardian passes for certified operator", async () => {
    const ctx = makeDealCtx();
    const result = await sourcing(ctx, {
      operators: makeOperatorSet(),
      departureAirport: KTEB,
    });
    updateDealContext(ctx, { sourcing: result.sourcing });

    const certs = makeCerts();
    const checks = checksAfterSourcing(ctx, certs);

    const certCheck = checks.find((c) => c.name === "part135_cert");
    expect(certCheck!.passed).toBe(true);
    expect(certCheck!.message).toContain("active");
  });

  it("Guardian fails for operator with expired cert", async () => {
    const ctx = makeDealCtx();
    // Force select the expired operator
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: {
          operatorId: "op_expired",
          operatorName: "Expired Aviation",
          phone: null,
          baseAirport: "KTEB",
          aircraftType: "Phenom 300E",
          aircraftTail: null,
          score: 0.8,
          scoreBreakdown: { proximity: 1.0, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 },
          distanceToDeparture: 0,
        },
        backupOperator: null,
        rankingReason: "Test",
        laneHistory: [],
      },
    });

    const checks = checksAfterSourcing(ctx, makeCerts());
    const certCheck = checks.find((c) => c.name === "part135_cert");
    expect(certCheck!.passed).toBe(false);
    expect(certCheck!.severity).toBe("critical");
  });

  it("Guardian warns when cert data unavailable (cold start)", async () => {
    const ctx = makeDealCtx();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: {
          operatorId: "op_unknown",
          operatorName: "Unknown Aviation",
          phone: null,
          baseAirport: "KTEB",
          aircraftType: "Phenom 300E",
          aircraftTail: null,
          score: 0.7,
          scoreBreakdown: { proximity: 0.8, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 },
          distanceToDeparture: 50,
        },
        backupOperator: null,
        rankingReason: "Test",
        laneHistory: [],
      },
    });

    // Pass certs that don't contain op_unknown
    const checks = checksAfterSourcing(ctx, makeCerts());
    const certCheck = checks.find((c) => c.name === "part135_cert");
    expect(certCheck!.severity).toBe("warning");
    expect(certCheck!.message).toContain("Verify manually");
  });

  it("Guardian catches aircraft type mismatch", async () => {
    const ctx = makeDealCtx();
    // Client requested Phenom 300E but operator has Citation CJ3+
    updateDealContext(ctx, {
      trip: { aircraftType: "Citation CJ3+" },
      sourcing: {
        selectedOperator: {
          operatorId: "op_a",
          operatorName: "Alpha Aviation",
          phone: null,
          baseAirport: "KTEB",
          aircraftType: "Phenom 300E",
          aircraftTail: null,
          score: 0.9,
          scoreBreakdown: { proximity: 1.0, laneHistory: 0.5, responseTime: 0.5, pricingAccuracy: 0.5, relationship: 0.5 },
          distanceToDeparture: 0,
        },
        backupOperator: null,
        rankingReason: "Test",
        laneHistory: [],
      },
    });

    const checks = checksAfterSourcing(ctx, makeCerts());
    const matchCheck = checks.find((c) => c.name === "aircraft_match");
    expect(matchCheck).toBeDefined();
    expect(matchCheck!.severity).toBe("warning");
    expect(matchCheck!.message).toContain("Citation CJ3+");
    expect(matchCheck!.message).toContain("Phenom 300E");
  });
});
