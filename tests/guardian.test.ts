/**
 * Tests for Guardian capability — stage-specific validation checks.
 * Covers all five validation stages per guardian.md spec:
 *   1. After INTAKE: airports, runway, range (haversine), pax, date
 *   2. After ESTIMATE: budget overlap, estimate sanity
 *   3. After SOURCING: operator certification, insurance, safety rating
 *   4. After QUOTE: quote vs estimate, margin policy, validity window
 *   5. Before PRESENTATION: final sanity
 *
 * Also verifies:
 *   - checkRange bug fix (old line 224): now uses haversine, not a no-op
 *   - Warning double-count bug fix (old line 361): pass/fail uses checks directly
 */

import { describe, it, expect } from "vitest";
import type { DealContext } from "../src/schemas/deal-context.js";
import type { AirportData, OperatorCertData } from "../src/capabilities/guardian.js";
import {
  guardian,
  checksAfterIntake,
  checksAfterEstimate,
  checksAfterSourcing,
  checksAfterQuote,
  checksBeforePresentation,
  AIRCRAFT_PERF,
  resolveAircraftPerf,
} from "../src/capabilities/guardian.js";
import { createDealContext, updateDealContext } from "../src/orchestrator/deal-context-manager.js";
import { _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";

// ── Test Fixtures ─────────────────────────────────────────────────────────

/** Build a realistic deal context with trip data populated. */
function makeDealContext(overrides?: Partial<{
  departure: string;
  arrival: string;
  date: string;
  pax: number;
  aircraftType: string | null;
  aircraftClass: string | null;
}>): DealContext {
  const ctx = createDealContext("sim");
  updateDealContext(ctx, {
    trip: {
      departure: overrides?.departure ?? "KTEB",
      arrival: overrides?.arrival ?? "KPBI",
      date: overrides?.date ?? "2026-12-15",
      pax: overrides?.pax ?? 4,
      aircraftType: overrides?.aircraftType ?? "Phenom 300E",
      aircraftClass: overrides?.aircraftClass ?? "light",
      isRoundTrip: false,
      specialRequirements: [],
    },
    client: {
      name: "Test Client",
      contact: "test@example.com",
      type: "new",
      budget: { min: 20000, max: 40000 },
      substitutionPref: null,
      qualified: true,
      qualificationReason: "Budget provided, valid route",
    },
  });
  return ctx;
}

/** Airport database for tests. */
function makeAirports(): Map<string, AirportData> {
  return new Map([
    ["KTEB", { icao: "KTEB", latitude: 40.8501, longitude: -74.0608, longest_runway_ft: 7000, customs_capable: true }],
    ["KPBI", { icao: "KPBI", latitude: 26.6832, longitude: -80.0956, longest_runway_ft: 10008, customs_capable: true }],
    ["KASE", { icao: "KASE", latitude: 39.2232, longitude: -106.8688, longest_runway_ft: 7006, customs_capable: false }],
    // Short runway airport for testing
    ["K12N", { icao: "K12N", latitude: 40.5660, longitude: -74.9998, longest_runway_ft: 2500, customs_capable: false }],
    // Far away airport for range testing (Honolulu)
    ["PHNL", { icao: "PHNL", latitude: 21.3187, longitude: -157.9225, longest_runway_ft: 12300, customs_capable: true }],
  ]);
}

/** Operator certification data for tests. */
function makeCerts(): Map<string, OperatorCertData> {
  return new Map([
    ["op_good", { operatorId: "op_good", part135Active: true, insuranceCurrent: true, argusRating: "gold", wyvernRating: null }],
    ["op_expired", { operatorId: "op_expired", part135Active: false, insuranceCurrent: false, argusRating: null, wyvernRating: null }],
    ["op_silver", { operatorId: "op_silver", part135Active: true, insuranceCurrent: true, argusRating: "silver", wyvernRating: null }],
    ["op_unverified", { operatorId: "op_unverified", part135Active: true, insuranceCurrent: null, argusRating: null, wyvernRating: null }],
  ]);
}

/** Standard operator match object. */
function makeOperator(id: string = "op_good", overrides?: Partial<DealContext["sourcing"]["selectedOperator"]>) {
  return {
    operatorId: id,
    operatorName: "Test Aviation",
    phone: "+1-555-0100",
    baseAirport: "KTEB",
    aircraftType: "Phenom 300E",
    aircraftTail: "N300TE",
    score: 0.85,
    scoreBreakdown: { proximity: 0.9, laneHistory: 0.5, responseTime: 0.8, pricingAccuracy: 0.9, relationship: 0.7 },
    distanceToDeparture: 0,
    ...overrides,
  };
}

// ── Aircraft Performance Lookup ──────────────────────────────────────────

describe("resolveAircraftPerf", () => {
  it("returns exact match for known aircraft type", () => {
    const perf = resolveAircraftPerf("Phenom 300E", null);
    expect(perf).not.toBeNull();
    expect(perf!.range_nm).toBe(2010);
    expect(perf!.runway_required_ft).toBe(3209);
    expect(perf!.passenger_capacity).toBe(8);
  });

  it("falls back to class defaults when type unknown", () => {
    const perf = resolveAircraftPerf("Unknown Jet", "heavy");
    expect(perf).not.toBeNull();
    expect(perf!.category).toBe("heavy");
  });

  it("returns null when both type and class are unknown", () => {
    const perf = resolveAircraftPerf("Unknown", "unknown_class");
    expect(perf).toBeNull();
  });

  it("has data for all 10 aircraft types", () => {
    expect(Object.keys(AIRCRAFT_PERF)).toHaveLength(10);
    for (const perf of Object.values(AIRCRAFT_PERF)) {
      expect(perf.range_nm).toBeGreaterThan(0);
      expect(perf.runway_required_ft).toBeGreaterThan(0);
      expect(perf.passenger_capacity).toBeGreaterThan(0);
    }
  });
});

// ── After INTAKE ─────────────────────────────────────────────────────────

describe("checksAfterIntake", () => {
  it("passes for valid KTEB→KPBI Phenom 300E trip", () => {
    const ctx = makeDealContext();
    const checks = checksAfterIntake(ctx, makeAirports());

    const failed = checks.filter((c) => !c.passed);
    expect(failed).toHaveLength(0);

    const names = checks.map((c) => c.name);
    expect(names).toContain("departure_airport");
    expect(names).toContain("arrival_airport");
    expect(names).toContain("runway_departure");
    expect(names).toContain("runway_arrival");
    expect(names).toContain("range");
    expect(names).toContain("pax_capacity");
    expect(names).toContain("date_future");
  });

  it("fails on missing departure airport", () => {
    const ctx = makeDealContext({ departure: "" });
    const checks = checksAfterIntake(ctx, makeAirports());

    const depCheck = checks.find((c) => c.name === "departure_airport");
    expect(depCheck).toBeDefined();
    expect(depCheck!.passed).toBe(false);
    expect(depCheck!.severity).toBe("critical");
  });

  it("warns on unknown airport (not in database)", () => {
    const ctx = makeDealContext({ departure: "KZZZ" });
    const checks = checksAfterIntake(ctx, makeAirports());

    const depCheck = checks.find((c) => c.name === "departure_airport");
    expect(depCheck).toBeDefined();
    expect(depCheck!.severity).toBe("warning");
    expect(depCheck!.message).toContain("not in airport database");
  });

  // ── Runway Checks ──────────────────────────────────────────────────

  it("fails when runway too short for aircraft", () => {
    // K12N has 2500ft runway, Phenom 300E needs 3209 + 10% = 3530ft
    const ctx = makeDealContext({ departure: "K12N" });
    const checks = checksAfterIntake(ctx, makeAirports());

    const runwayCheck = checks.find((c) => c.name === "runway_departure");
    expect(runwayCheck).toBeDefined();
    expect(runwayCheck!.passed).toBe(false);
    expect(runwayCheck!.severity).toBe("critical");
    expect(runwayCheck!.message).toContain("2500");
    expect(runwayCheck!.message).toContain("too short");
  });

  it("passes when runway is adequate", () => {
    // KTEB has 7000ft, Phenom 300E needs 3530ft with margin
    const ctx = makeDealContext();
    const checks = checksAfterIntake(ctx, makeAirports());

    const runwayDep = checks.find((c) => c.name === "runway_departure");
    const runwayArr = checks.find((c) => c.name === "runway_arrival");
    expect(runwayDep!.passed).toBe(true);
    expect(runwayArr!.passed).toBe(true);
  });

  it("applies 10% safety margin to runway requirement", () => {
    const ctx = makeDealContext({ aircraftType: "Phenom 300E" });
    const checks = checksAfterIntake(ctx, makeAirports());

    // Phenom 300E: 3209ft * 1.10 = 3530ft margin
    const runwayCheck = checks.find((c) => c.name === "runway_departure");
    expect(runwayCheck!.message).toContain("3530"); // 3209 * 1.10 = 3529.9 → ceil = 3530
  });

  // ── Range Checks (haversine fix for old bug at line 224) ───────────

  it("passes for KTEB→KPBI (within range)", () => {
    // KTEB→KPBI is ~950nm, Phenom 300E has 2010nm range
    const ctx = makeDealContext();
    const checks = checksAfterIntake(ctx, makeAirports());

    const rangeCheck = checks.find((c) => c.name === "range");
    expect(rangeCheck).toBeDefined();
    expect(rangeCheck!.passed).toBe(true);
    expect(rangeCheck!.message).toContain("within");
  });

  it("fails for KTEB→PHNL with Phenom 300E (exceeds range)", () => {
    // KTEB→PHNL (Honolulu) is ~4300nm, Phenom 300E safe range is 2010/1.10 = ~1827nm
    const ctx = makeDealContext({ arrival: "PHNL" });
    const checks = checksAfterIntake(ctx, makeAirports());

    const rangeCheck = checks.find((c) => c.name === "range");
    expect(rangeCheck).toBeDefined();
    expect(rangeCheck!.passed).toBe(false);
    expect(rangeCheck!.severity).toBe("critical");
    expect(rangeCheck!.message).toContain("exceeds");
  });

  it("uses haversine to compute actual distance (not a no-op)", () => {
    // Verify that the range check actually computes distance
    const ctx = makeDealContext();
    const checks = checksAfterIntake(ctx, makeAirports());

    const rangeCheck = checks.find((c) => c.name === "range");
    expect(rangeCheck).toBeDefined();
    // The message should contain the computed distance
    expect(rangeCheck!.message).toMatch(/\d+nm/);
  });

  it("applies 10% IFR reserve margin to range", () => {
    // Phenom 300E range 2010nm → safe range = 2010/1.10 = 1827nm
    const ctx = makeDealContext();
    const checks = checksAfterIntake(ctx, makeAirports());

    const rangeCheck = checks.find((c) => c.name === "range");
    expect(rangeCheck!.message).toContain("1827");
  });

  // ── Pax Capacity ───────────────────────────────────────────────────

  it("fails when pax exceeds capacity", () => {
    // Phenom 300E seats 8
    const ctx = makeDealContext({ pax: 10 });
    const checks = checksAfterIntake(ctx, makeAirports());

    const paxCheck = checks.find((c) => c.name === "pax_capacity");
    expect(paxCheck!.passed).toBe(false);
    expect(paxCheck!.severity).toBe("critical");
    expect(paxCheck!.message).toContain("exceeds");
  });

  it("warns when pax equals capacity (no margin)", () => {
    // Phenom 300E seats 8
    const ctx = makeDealContext({ pax: 8 });
    const checks = checksAfterIntake(ctx, makeAirports());

    const paxCheck = checks.find((c) => c.name === "pax_capacity");
    expect(paxCheck!.passed).toBe(true);
    expect(paxCheck!.severity).toBe("warning");
    expect(paxCheck!.message).toContain("max capacity");
  });

  it("passes when pax well within capacity", () => {
    const ctx = makeDealContext({ pax: 4 });
    const checks = checksAfterIntake(ctx, makeAirports());

    const paxCheck = checks.find((c) => c.name === "pax_capacity");
    expect(paxCheck!.passed).toBe(true);
    expect(paxCheck!.severity).toBe("info");
    expect(paxCheck!.message).toContain("4 seats margin");
  });

  // ── Date ──────────────────────────────────────────────────────────

  it("fails when date is in the past", () => {
    const ctx = makeDealContext({ date: "2020-01-01" });
    const checks = checksAfterIntake(ctx, makeAirports());

    const dateCheck = checks.find((c) => c.name === "date_future");
    expect(dateCheck!.passed).toBe(false);
    expect(dateCheck!.severity).toBe("critical");
    expect(dateCheck!.message).toContain("past");
  });

  it("passes when date is in the future", () => {
    const ctx = makeDealContext({ date: "2027-06-15" });
    const checks = checksAfterIntake(ctx, makeAirports());

    const dateCheck = checks.find((c) => c.name === "date_future");
    expect(dateCheck!.passed).toBe(true);
  });

  it("fails when no date specified", () => {
    const ctx = makeDealContext({ date: "" });
    const checks = checksAfterIntake(ctx, makeAirports());

    const dateCheck = checks.find((c) => c.name === "date_future");
    expect(dateCheck!.passed).toBe(false);
    expect(dateCheck!.message).toContain("No trip date");
  });

  // ── Class Fallback ─────────────────────────────────────────────────

  it("uses class defaults when aircraft type unknown", () => {
    const ctx = makeDealContext({ aircraftType: null, aircraftClass: "heavy" });
    const checks = checksAfterIntake(ctx, makeAirports());

    // Should still have range and runway checks using heavy defaults
    const rangeCheck = checks.find((c) => c.name === "range");
    expect(rangeCheck).toBeDefined();
    const runwayCheck = checks.find((c) => c.name === "runway_departure");
    expect(runwayCheck).toBeDefined();
  });
});

// ── After ESTIMATE ───────────────────────────────────────────────────────

describe("checksAfterEstimate", () => {
  it("passes when budget overlaps estimate range", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 300,
        positioning: 0,
        calculatedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterEstimate(ctx);
    const budgetCheck = checks.find((c) => c.name === "budget_overlap");
    expect(budgetCheck).toBeDefined();
    expect(budgetCheck!.passed).toBe(true);
    expect(budgetCheck!.message).toContain("overlaps");
  });

  it("fails when budget max below estimate floor", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      client: { budget: { min: 10000, max: 15000 } },
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 300,
        positioning: 0,
        calculatedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterEstimate(ctx);
    const budgetCheck = checks.find((c) => c.name === "budget_overlap");
    expect(budgetCheck!.passed).toBe(false);
    expect(budgetCheck!.severity).toBe("critical");
    expect(budgetCheck!.message).toContain("below estimate floor");
  });

  it("warns when client min above estimate high (premium expectation)", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      client: { budget: { min: 50000, max: 80000 } },
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 300,
        positioning: 0,
        calculatedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterEstimate(ctx);
    const budgetCheck = checks.find((c) => c.name === "budget_overlap");
    expect(budgetCheck!.severity).toBe("warning");
    expect(budgetCheck!.message).toContain("premium");
  });

  it("warns on suspiciously low estimate (possible API error)", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 500, high: 1000 },
        fuelBurn: 300,
        positioning: 0,
        calculatedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterEstimate(ctx);
    const sanityCheck = checks.find((c) => c.name === "estimate_sanity");
    expect(sanityCheck).toBeDefined();
    expect(sanityCheck!.severity).toBe("warning");
    expect(sanityCheck!.message).toContain("unusually low");
  });

  it("warns when no estimate available", () => {
    const ctx = makeDealContext();
    // estimate.priceRange is null by default

    const checks = checksAfterEstimate(ctx);
    const estCheck = checks.find((c) => c.name === "estimate_available");
    expect(estCheck!.severity).toBe("warning");
  });

  it("warns when no budget set", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      client: { budget: null },
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: null,
        positioning: null,
        calculatedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterEstimate(ctx);
    const budgetCheck = checks.find((c) => c.name === "budget_overlap");
    expect(budgetCheck!.severity).toBe("warning");
    expect(budgetCheck!.message).toContain("not set");
  });
});

// ── After SOURCING ───────────────────────────────────────────────────────

describe("checksAfterSourcing", () => {
  it("passes for certified operator with gold rating", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_good"),
        backupOperator: null,
        rankingReason: "Closest operator",
        laneHistory: [],
      },
    });

    const checks = checksAfterSourcing(ctx, makeCerts());
    const certCheck = checks.find((c) => c.name === "part135_cert");
    const insCheck = checks.find((c) => c.name === "insurance");
    const safetyCheck = checks.find((c) => c.name === "safety_rating");

    expect(certCheck!.passed).toBe(true);
    expect(insCheck!.passed).toBe(true);
    expect(safetyCheck!.passed).toBe(true);
    expect(safetyCheck!.message).toContain("ARGUS gold");
  });

  it("fails for operator with expired Part 135", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_expired"),
        backupOperator: null,
        rankingReason: "Only option",
        laneHistory: [],
      },
    });

    const checks = checksAfterSourcing(ctx, makeCerts());
    const certCheck = checks.find((c) => c.name === "part135_cert");
    expect(certCheck!.passed).toBe(false);
    expect(certCheck!.severity).toBe("critical");
    expect(certCheck!.message).toContain("NOT active");
  });

  it("fails for operator with expired insurance", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_expired"),
        backupOperator: null,
        rankingReason: "Only option",
        laneHistory: [],
      },
    });

    const checks = checksAfterSourcing(ctx, makeCerts());
    const insCheck = checks.find((c) => c.name === "insurance");
    expect(insCheck!.passed).toBe(false);
    expect(insCheck!.severity).toBe("critical");
  });

  it("warns for silver safety rating", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_silver"),
        backupOperator: null,
        rankingReason: "Best available",
        laneHistory: [],
      },
    });

    const checks = checksAfterSourcing(ctx, makeCerts());
    const safetyCheck = checks.find((c) => c.name === "safety_rating");
    expect(safetyCheck!.severity).toBe("warning");
    expect(safetyCheck!.message).toContain("Silver");
  });

  it("warns when no cert data available (cold start)", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_unknown"),
        backupOperator: null,
        rankingReason: "New operator",
        laneHistory: [],
      },
    });

    // Pass cert map that doesn't have this operator
    const checks = checksAfterSourcing(ctx, makeCerts());
    const certCheck = checks.find((c) => c.name === "part135_cert");
    expect(certCheck!.severity).toBe("warning");
    expect(certCheck!.message).toContain("Verify manually");
  });

  it("warns when insurance status is null (unverified)", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_unverified"),
        backupOperator: null,
        rankingReason: "Only option",
        laneHistory: [],
      },
    });

    const checks = checksAfterSourcing(ctx, makeCerts());
    const insCheck = checks.find((c) => c.name === "insurance");
    expect(insCheck!.severity).toBe("warning");
    expect(insCheck!.message).toContain("unverified");
  });

  it("fails when no operator selected", () => {
    const ctx = makeDealContext();
    // sourcing.selectedOperator is null by default

    const checks = checksAfterSourcing(ctx);
    const opCheck = checks.find((c) => c.name === "operator_selected");
    expect(opCheck!.passed).toBe(false);
    expect(opCheck!.severity).toBe("critical");
  });

  it("warns when aircraft type mismatch", () => {
    const ctx = makeDealContext({ aircraftType: "Citation CJ3+" });
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_good", { aircraftType: "Phenom 300E" }),
        backupOperator: null,
        rankingReason: "Closest",
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

// ── After QUOTE ──────────────────────────────────────────────────────────

describe("checksAfterQuote", () => {
  function ctxWithQuote(operatorPrice: number, margin: number, estimateLow: number, estimateHigh: number): DealContext {
    const ctx = makeDealContext();
    const osaPrice = operatorPrice / (1 - margin);
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: estimateLow, high: estimateHigh },
        fuelBurn: 300,
        positioning: 0,
        calculatedAt: new Date().toISOString(),
      },
      quote: {
        operatorPrice,
        osaPrice,
        margin,
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(), // 2 hours
        aircraft: { type: "Phenom 300E", tail: "N300TE", year: 2022 },
        quotedAt: new Date().toISOString(),
      },
    });
    return ctx;
  }

  it("passes when quote within 25% of estimate median", () => {
    // Estimate: $25K-$35K, median $30K. Quote $28K → 6.7% off. Pass.
    const ctx = ctxWithQuote(28000, 0.08, 25000, 35000);
    const checks = checksAfterQuote(ctx);

    const vsEstimate = checks.find((c) => c.name === "quote_vs_estimate");
    expect(vsEstimate!.passed).toBe(true);
    expect(vsEstimate!.message).toContain("within");
  });

  it("warns when quote more than 25% off estimate median", () => {
    // Estimate: $25K-$35K, median $30K. Quote $42K → 40% off. Warn.
    const ctx = ctxWithQuote(42000, 0.08, 25000, 35000);
    const checks = checksAfterQuote(ctx);

    const vsEstimate = checks.find((c) => c.name === "quote_vs_estimate");
    expect(vsEstimate!.severity).toBe("warning");
    expect(vsEstimate!.message).toContain("40%");
  });

  it("passes when margin within policy (8-15%)", () => {
    const ctx = ctxWithQuote(28000, 0.10, 25000, 35000);
    const checks = checksAfterQuote(ctx);

    const marginCheck = checks.find((c) => c.name === "margin_policy");
    expect(marginCheck!.passed).toBe(true);
    expect(marginCheck!.message).toContain("within policy");
  });

  it("warns when margin below minimum (6%)", () => {
    const ctx = ctxWithQuote(28000, 0.04, 25000, 35000);
    const checks = checksAfterQuote(ctx);

    const marginCheck = checks.find((c) => c.name === "margin_policy");
    expect(marginCheck!.severity).toBe("warning");
    expect(marginCheck!.message).toContain("below minimum");
  });

  it("warns when margin above maximum (15%)", () => {
    const ctx = ctxWithQuote(28000, 0.20, 25000, 35000);
    const checks = checksAfterQuote(ctx);

    const marginCheck = checks.find((c) => c.name === "margin_policy");
    expect(marginCheck!.severity).toBe("warning");
    expect(marginCheck!.message).toContain("above maximum");
  });

  it("warns when quote validity under 30 minutes", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      quote: {
        operatorPrice: 28000,
        osaPrice: 30400,
        margin: 0.08,
        validUntil: new Date(Date.now() + 15 * 60_000).toISOString(), // 15 min
        aircraft: { type: "Phenom 300E", tail: "N300TE", year: 2022 },
        quotedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterQuote(ctx);
    const validityCheck = checks.find((c) => c.name === "quote_validity");
    expect(validityCheck!.severity).toBe("warning");
    expect(validityCheck!.message).toContain("Under");
  });

  it("warns when no operator quote entered yet", () => {
    const ctx = makeDealContext();
    const checks = checksAfterQuote(ctx);

    const quoteCheck = checks.find((c) => c.name === "quote_available");
    expect(quoteCheck!.severity).toBe("warning");
    expect(quoteCheck!.message).toContain("No operator quote");
  });
});

// ── Before PRESENTATION ──────────────────────────────────────────────────

describe("checksBeforePresentation", () => {
  it("passes when all required data present", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator(),
        backupOperator: null,
        rankingReason: "Best match",
        laneHistory: [],
      },
      quote: {
        operatorPrice: 28000,
        osaPrice: 30400,
        margin: 0.08,
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
        aircraft: { type: "Phenom 300E", tail: "N300TE", year: 2022 },
        quotedAt: new Date().toISOString(),
      },
    });

    const checks = checksBeforePresentation(ctx);
    const failed = checks.filter((c) => !c.passed);
    expect(failed).toHaveLength(0);
    expect(checks.find((c) => c.name === "pre_present_complete")).toBeDefined();
  });

  it("fails when no operator selected", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      quote: {
        operatorPrice: 28000,
        osaPrice: 30400,
        margin: 0.08,
        validUntil: null,
        aircraft: null,
        quotedAt: null,
      },
    });

    const checks = checksBeforePresentation(ctx);
    const opCheck = checks.find((c) => c.name === "pre_present_operator");
    expect(opCheck!.passed).toBe(false);
    expect(opCheck!.severity).toBe("critical");
  });

  it("fails when no OSA price", () => {
    const ctx = makeDealContext();
    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator(),
        backupOperator: null,
        rankingReason: "Best match",
        laneHistory: [],
      },
    });
    // quote.osaPrice is null by default

    const checks = checksBeforePresentation(ctx);
    const priceCheck = checks.find((c) => c.name === "pre_present_price");
    expect(priceCheck!.passed).toBe(false);
  });
});

// ── Full Guardian (main entry point) ─────────────────────────────────────

describe("guardian (main entry)", () => {
  it("returns passed=true for valid intake", async () => {
    const ctx = makeDealContext();
    const result = await guardian("intake", ctx, { airports: makeAirports() });

    expect(result.pass.stage).toBe("intake");
    expect(result.pass.passed).toBe(true);
    expect(result.pass.checks.length).toBeGreaterThan(0);
    expect(result.pass.timestamp).toBeDefined();
  });

  it("returns passed=false when any critical check fails", async () => {
    // Too many pax for Phenom 300E
    const ctx = makeDealContext({ pax: 12 });
    const result = await guardian("intake", ctx, { airports: makeAirports() });

    expect(result.pass.passed).toBe(false);
    const critical = result.pass.checks.filter((c) => !c.passed && c.severity === "critical");
    expect(critical.length).toBeGreaterThan(0);
  });

  it("returns passed=true when only warnings present (no double-count)", async () => {
    // Pax at max capacity → warning, but not a failure
    const ctx = makeDealContext({ pax: 8 }); // Phenom 300E seats exactly 8
    const result = await guardian("intake", ctx, { airports: makeAirports() });

    expect(result.pass.passed).toBe(true);
    // Verify warning exists but doesn't cause failure
    const warnings = result.pass.checks.filter((c) => c.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("routes to correct stage checks", async () => {
    const ctx = makeDealContext();

    const intake = await guardian("intake", ctx, { airports: makeAirports() });
    expect(intake.pass.checks.some((c) => c.name === "departure_airport")).toBe(true);

    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 300,
        positioning: 0,
        calculatedAt: new Date().toISOString(),
      },
    });
    const estimated = await guardian("estimated", ctx);
    expect(estimated.pass.checks.some((c) => c.name === "budget_overlap")).toBe(true);

    updateDealContext(ctx, {
      sourcing: {
        selectedOperator: makeOperator("op_good"),
        backupOperator: null,
        rankingReason: "Closest",
        laneHistory: [],
      },
    });
    const sourced = await guardian("sourced", ctx, { operatorCerts: makeCerts() });
    expect(sourced.pass.checks.some((c) => c.name === "operator_selected")).toBe(true);

    updateDealContext(ctx, {
      quote: {
        operatorPrice: 28000,
        osaPrice: 30400,
        margin: 0.08,
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
        aircraft: { type: "Phenom 300E", tail: "N300TE", year: 2022 },
        quotedAt: new Date().toISOString(),
      },
    });
    const quoted = await guardian("quoted", ctx);
    expect(quoted.pass.checks.some((c) => c.name === "quote_vs_estimate")).toBe(true);

    const presented = await guardian("presented", ctx);
    expect(presented.pass.checks.some((c) => c.name === "pre_present_complete")).toBe(true);
  });

  it("handles unknown stage gracefully", async () => {
    const ctx = makeDealContext();
    const result = await guardian("some_future_stage", ctx);
    expect(result.pass.passed).toBe(true);
    expect(result.pass.checks[0]!.name).toBe("unknown_stage");
  });
});

// ── Bug Fix Verification ──────────────────────────────────────────────────

describe("bug fixes from old simulator", () => {
  it("checkRange actually uses haversine (fix for old line 224 no-op)", async () => {
    // The old guardian always returned pass for range.
    // New implementation should FAIL for KTEB→PHNL with a light jet.
    const ctx = makeDealContext({ arrival: "PHNL", aircraftType: "Phenom 300E" });
    const result = await guardian("intake", ctx, { airports: makeAirports() });

    const rangeCheck = result.pass.checks.find((c) => c.name === "range");
    expect(rangeCheck).toBeDefined();
    expect(rangeCheck!.passed).toBe(false);
    expect(rangeCheck!.severity).toBe("critical");
    // Verify actual distance was computed
    expect(rangeCheck!.message).toMatch(/\d{3,}nm exceeds/);
  });

  it("warning double-count fixed (old line 361): warnings do not cause pass=false", async () => {
    // Build a context with multiple warnings but no critical failures.
    // Old code would double-count warnings (checklist + flags) and potentially
    // incorrectly fail the deal. New code only uses checks array.
    const ctx = makeDealContext({ pax: 8 }); // at capacity → warning
    // Use an airport not in database → warning
    updateDealContext(ctx, {
      trip: { departure: "KZZZ", arrival: "KYYZ" }, // neither in airport DB
    });

    const result = await guardian("intake", ctx, { airports: makeAirports() });

    // Should have multiple warnings
    const warnings = result.pass.checks.filter((c) => c.severity === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(2);

    // But should still pass (no critical failures for unknown airports — just warnings)
    // The key fix: warnings are counted once, not doubled
    expect(result.pass.passed).toBe(true);
  });
});
