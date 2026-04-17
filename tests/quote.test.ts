/**
 * Tests for Quote capability — two-phase pricing pipeline.
 *
 * Coverage:
 * 1. Phase 1 (estimate): successful Aviapages call, API failure fallback
 * 2. Historical delta correction from DealStore memory
 * 3. Budget mismatch detection
 * 4. Phase 2 (real quote): margin calculation, OSA price formula
 * 5. Quote vs estimate sanity check (via Guardian integration)
 * 6. Edge cases: no budget, no estimate, zero values
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  estimate,
  quote,
  checkBudgetFit,
  calcEstimateDelta,
} from "../src/capabilities/quote.js";
import { checksAfterEstimate, checksAfterQuote } from "../src/capabilities/guardian.js";
import { AviapagesClient } from "../src/integrations/aviapages.js";
import type { FetchFn, PriceEstimateResult } from "../src/integrations/aviapages.js";
import { DealStore } from "../src/memory/deal-store.js";
import type { DealRecord } from "../src/schemas/deal-record.js";
import type { DealContext } from "../src/schemas/deal-context.js";
import { createDealContext, updateDealContext } from "../src/orchestrator/deal-context-manager.js";
import { MARGIN_POLICY, QUOTE_VALIDITY } from "../src/config.js";
import { createTestDb } from "../src/memory/database.js";

// ── Test Helpers ──────────────────────────────────────────────────────────

/** Create a mock Aviapages fetch that returns a fixed price estimate. */
function mockFetch(result: PriceEstimateResult): FetchFn {
  return async (_url: string, _init: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => ({
      price_low: result.low,
      price_high: result.high,
      flight_time: result.flightTime,
      fuel_burn: result.fuelBurn,
    }),
  });
}

/** Create a mock fetch that fails. */
function failingFetch(): FetchFn {
  return async () => ({ ok: false, status: 500, json: async () => ({}) });
}

/** Create a mock fetch that throws. */
function throwingFetch(): FetchFn {
  return async () => { throw new Error("Network error"); };
}

/** Create a deal context with trip and budget populated. */
function makeDealCtx(overrides?: {
  budgetMin?: number;
  budgetMax?: number;
  departure?: string;
  arrival?: string;
}): DealContext {
  const ctx = createDealContext("sim");
  updateDealContext(ctx, {
    trip: {
      departure: overrides?.departure ?? "KTEB",
      arrival: overrides?.arrival ?? "KPBI",
      date: "2026-04-15",
      pax: 4,
      aircraftClass: "light",
      aircraftType: "Phenom 300E",
      isRoundTrip: false,
      specialRequirements: [],
    },
    client: {
      name: "Test Client",
      contact: "test@example.com",
      type: "new",
      budget: { min: overrides?.budgetMin ?? 20000, max: overrides?.budgetMax ?? 40000 },
      substitutionPref: null,
      qualified: true,
      qualificationReason: "Fully qualified",
    },
  });
  return ctx;
}

/** Create a DealStore backed by an in-memory SQLite database with historical deals. */
function makeStoreWithDeals(records: DealRecord[]): { store: DealStore; cleanup: () => void } {
  const db = createTestDb();
  const store = new DealStore(db);
  for (const r of records) store.add(r);
  return { store, cleanup: () => db.close() };
}

/** Make a historical deal record for pricing delta tests. */
function makeDealRecord(overrides: Partial<DealRecord> = {}): DealRecord {
  return {
    id: "deal_hist_001",
    timestamp: "2026-03-01T10:00:00.000Z",
    mode: "live",
    route: { departure: "KTEB", arrival: "KPBI", distance: 950 },
    aviapagesEstimate: { low: 25000, high: 35000 },
    operatorQuote: 33600,  // +12% above median of 30000
    osaPrice: 36522,
    estimateDelta: 0.12,   // (33600 - 30000) / 30000
    operatorName: "Elite Aviation",
    operatorBase: "KTEB",
    operatorResponseTime: 3600,
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
    revenue: 2922,
    margin: 0.08,
    totalDealTime: 7200,
    dayOfWeek: 2,
    season: "shoulder",
    guardianFlags: [],
    ...overrides,
  };
}

// ── Phase 1: Estimate ────────────────────────────────────────────────────

describe("estimate (Phase 1)", () => {
  it("returns price range from successful Aviapages call", async () => {
    const apiResult: PriceEstimateResult = { low: 25000, high: 35000, flightTime: 150, fuelBurn: 280 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx();

    const result = await estimate(ctx, { aviapages: client });

    expect(result.estimate.source).toBe("aviapages");
    expect(result.estimate.priceRange).not.toBeNull();
    expect(result.estimate.priceRange!.low).toBe(25000);
    expect(result.estimate.priceRange!.high).toBe(35000);
    expect(result.estimate.flightTime).toBe(150);
    expect(result.estimate.fuelBurn).toBe(280);
    expect(result.estimate.calculatedAt).not.toBeNull();
  });

  it("returns manual source when Aviapages unavailable", async () => {
    const ctx = makeDealCtx();
    const result = await estimate(ctx, { aviapages: null });

    expect(result.estimate.source).toBe("manual");
    expect(result.estimate.priceRange).toBeNull();
    expect(result.estimate.calculatedAt).toBeNull();
  });

  it("returns manual source when API returns error", async () => {
    const client = new AviapagesClient({ apiKey: "test" }, failingFetch());
    const ctx = makeDealCtx();

    const result = await estimate(ctx, { aviapages: client });

    expect(result.estimate.source).toBe("manual");
    expect(result.estimate.priceRange).toBeNull();
  });

  it("handles network errors gracefully", async () => {
    const client = new AviapagesClient({ apiKey: "test" }, throwingFetch());
    const ctx = makeDealCtx();

    const result = await estimate(ctx, { aviapages: client });

    expect(result.estimate.source).toBe("manual");
    expect(result.estimate.priceRange).toBeNull();
  });

  it("passes correct params to Aviapages API", async () => {
    let capturedBody: unknown;
    const captureFetch: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ price_low: 25000, price_high: 35000, flight_time: 150, fuel_burn: 280 }),
      };
    };
    const client = new AviapagesClient({ apiKey: "test-key" }, captureFetch);
    const ctx = makeDealCtx();

    await estimate(ctx, { aviapages: client });

    expect(capturedBody).toEqual({
      departure: "KTEB",
      arrival: "KPBI",
      aircraft_type: "Phenom 300E",
      date: "2026-04-15",
      pax: 4,
    });
  });

  it("handles zero flightTime and fuelBurn as null", async () => {
    const apiResult: PriceEstimateResult = { low: 25000, high: 35000, flightTime: 0, fuelBurn: 0 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx();

    const result = await estimate(ctx, { aviapages: client });

    expect(result.estimate.flightTime).toBeNull();
    expect(result.estimate.fuelBurn).toBeNull();
  });
});

// ── Historical Delta Correction ──────────────────────────────────────────

describe("estimate with historical delta correction", () => {
  it("adjusts estimate range using historical pricing delta", async () => {
    // Historical deals show Aviapages underestimates by 12% on KTEB→KPBI
    const records = [
      makeDealRecord({ estimateDelta: 0.10 }),
      makeDealRecord({ id: "deal_hist_002", estimateDelta: 0.14 }),
    ];
    // Average delta: (0.10 + 0.14) / 2 = 0.12
    const { store, cleanup } = makeStoreWithDeals(records);

    const apiResult: PriceEstimateResult = { low: 25000, high: 35000, flightTime: 150, fuelBurn: 280 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx();

    const result = await estimate(ctx, { aviapages: client, dealStore: store });

    // Adjusted: 25000 * 1.12 = 28000, 35000 * 1.12 = 39200
    expect(result.estimate.priceRange!.low).toBe(28000);
    expect(result.estimate.priceRange!.high).toBe(39200);

    cleanup();
  });

  it("applies negative delta (Aviapages overestimates)", async () => {
    const records = [
      makeDealRecord({ estimateDelta: -0.08 }),
    ];
    const { store, cleanup } = makeStoreWithDeals(records);

    const apiResult: PriceEstimateResult = { low: 30000, high: 40000, flightTime: 150, fuelBurn: 280 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx();

    const result = await estimate(ctx, { aviapages: client, dealStore: store });

    // Adjusted: 30000 * 0.92 = 27600, 40000 * 0.92 = 36800
    expect(result.estimate.priceRange!.low).toBe(27600);
    expect(result.estimate.priceRange!.high).toBe(36800);

    cleanup();
  });

  it("uses raw API result when no historical data exists", async () => {
    const { store, cleanup } = makeStoreWithDeals([]);

    const apiResult: PriceEstimateResult = { low: 25000, high: 35000, flightTime: 150, fuelBurn: 280 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx();

    const result = await estimate(ctx, { aviapages: client, dealStore: store });

    expect(result.estimate.priceRange!.low).toBe(25000);
    expect(result.estimate.priceRange!.high).toBe(35000);

    cleanup();
  });

  it("uses raw API result when store has deals for different route", async () => {
    const records = [
      makeDealRecord({ route: { departure: "KORD", arrival: "KASE", distance: 1200 }, estimateDelta: 0.20 }),
    ];
    const { store, cleanup } = makeStoreWithDeals(records);

    const apiResult: PriceEstimateResult = { low: 25000, high: 35000, flightTime: 150, fuelBurn: 280 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx(); // KTEB→KPBI

    const result = await estimate(ctx, { aviapages: client, dealStore: store });

    // No delta for KTEB→KPBI, so raw values
    expect(result.estimate.priceRange!.low).toBe(25000);
    expect(result.estimate.priceRange!.high).toBe(35000);

    cleanup();
  });
});

// ── Budget Mismatch ──────────────────────────────────────────────────────

describe("checkBudgetFit", () => {
  it("returns null when budget overlaps estimate", () => {
    expect(checkBudgetFit(
      { min: 20000, max: 40000 },
      { low: 25000, high: 35000 },
    )).toBeNull();
  });

  it("returns reason when budget max below estimate floor", () => {
    const reason = checkBudgetFit(
      { min: 10000, max: 15000 },
      { low: 25000, high: 35000 },
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("15,000");
    expect(reason).toContain("25,000");
  });

  it("returns null when budget is null (can't check)", () => {
    expect(checkBudgetFit(null, { low: 25000, high: 35000 })).toBeNull();
  });

  it("returns null when estimate is null (can't check)", () => {
    expect(checkBudgetFit({ min: 20000, max: 40000 }, null)).toBeNull();
  });

  it("returns null when budget min above estimate high (premium client)", () => {
    // Budget above range is unusual but not a mismatch — client wants premium
    expect(checkBudgetFit(
      { min: 50000, max: 80000 },
      { low: 25000, high: 35000 },
    )).toBeNull();
  });
});

describe("budget mismatch via Guardian", () => {
  it("Guardian blocks when budget max below adjusted estimate floor", () => {
    const ctx = makeDealCtx({ budgetMin: 10000, budgetMax: 15000 });
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 280,
        positioning: null,
        calculatedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterEstimate(ctx);
    const budgetCheck = checks.find((c) => c.name === "budget_overlap");
    expect(budgetCheck).toBeDefined();
    expect(budgetCheck!.passed).toBe(false);
    expect(budgetCheck!.severity).toBe("critical");
  });

  it("Guardian passes when budget overlaps estimate", () => {
    const ctx = makeDealCtx({ budgetMin: 20000, budgetMax: 40000 });
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 280,
        positioning: null,
        calculatedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterEstimate(ctx);
    const budgetCheck = checks.find((c) => c.name === "budget_overlap");
    expect(budgetCheck!.passed).toBe(true);
  });
});

// ── Phase 2: Real Quote ──────────────────────────────────────────────────

describe("quote (Phase 2)", () => {
  it("calculates OSA price with default margin (8%)", async () => {
    const ctx = makeDealCtx();
    const result = await quote(ctx, { operatorPrice: 28000 });

    // OSA price = 28000 / (1 - 0.08) = 28000 / 0.92 = 30434.78 → rounded to 30435
    expect(result.quote.operatorPrice).toBe(28000);
    expect(result.quote.osaPrice).toBe(Math.round(28000 / (1 - MARGIN_POLICY.target)));
    expect(result.quote.margin).toBe(MARGIN_POLICY.target);
  });

  it("calculates OSA price with custom margin", async () => {
    const ctx = makeDealCtx();
    const result = await quote(ctx, { operatorPrice: 28000, margin: 0.10 });

    // OSA price = 28000 / 0.90 = 31111.11 → 31111
    expect(result.quote.osaPrice).toBe(Math.round(28000 / 0.90));
    expect(result.quote.margin).toBe(0.10);
  });

  it("sets validity window from config default", async () => {
    const ctx = makeDealCtx();
    const before = Date.now();
    const result = await quote(ctx, { operatorPrice: 28000 });
    const after = Date.now();

    expect(result.quote.validUntil).not.toBeNull();
    const validTime = new Date(result.quote.validUntil!).getTime();
    const expectedMs = QUOTE_VALIDITY.defaultMinutes * 60_000;
    expect(validTime).toBeGreaterThanOrEqual(before + expectedMs - 1000);
    expect(validTime).toBeLessThanOrEqual(after + expectedMs + 1000);
  });

  it("sets custom validity window", async () => {
    const ctx = makeDealCtx();
    const before = Date.now();
    const result = await quote(ctx, { operatorPrice: 28000, validityMinutes: 60 });

    const validTime = new Date(result.quote.validUntil!).getTime();
    expect(validTime).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000);
  });

  it("includes aircraft details when provided", async () => {
    const ctx = makeDealCtx();
    const result = await quote(ctx, {
      operatorPrice: 28000,
      aircraft: { type: "Phenom 300E", tail: "N300TE", year: 2022 },
    });

    expect(result.quote.aircraft).toEqual({ type: "Phenom 300E", tail: "N300TE", year: 2022 });
  });

  it("sets aircraft to null when not provided", async () => {
    const ctx = makeDealCtx();
    const result = await quote(ctx, { operatorPrice: 28000 });

    expect(result.quote.aircraft).toBeNull();
  });

  it("sets quotedAt timestamp", async () => {
    const ctx = makeDealCtx();
    const before = new Date().toISOString();
    const result = await quote(ctx, { operatorPrice: 28000 });

    expect(result.quote.quotedAt).not.toBeNull();
    expect(result.quote.quotedAt! >= before).toBe(true);
  });
});

// ── Margin Calculations ──────────────────────────────────────────────────

describe("margin calculation edge cases", () => {
  it("margin at policy minimum (6%)", async () => {
    const ctx = makeDealCtx();
    const result = await quote(ctx, { operatorPrice: 28000, margin: MARGIN_POLICY.min });

    // 28000 / 0.94 = 29787.23 → 29787
    expect(result.quote.osaPrice).toBe(Math.round(28000 / (1 - MARGIN_POLICY.min)));
    expect(result.quote.osaPrice!).toBeGreaterThan(28000);
  });

  it("margin at policy maximum (15%)", async () => {
    const ctx = makeDealCtx();
    const result = await quote(ctx, { operatorPrice: 28000, margin: MARGIN_POLICY.max });

    // 28000 / 0.85 = 32941.18 → 32941
    expect(result.quote.osaPrice).toBe(Math.round(28000 / (1 - MARGIN_POLICY.max)));
  });

  it("margin is percentage of final price, not markup on cost", async () => {
    const ctx = makeDealCtx();
    const result = await quote(ctx, { operatorPrice: 28000, margin: 0.10 });

    // Verify: (osaPrice - operatorPrice) / osaPrice ≈ 0.10
    const actualMargin = (result.quote.osaPrice! - result.quote.operatorPrice!) / result.quote.osaPrice!;
    expect(Math.abs(actualMargin - 0.10)).toBeLessThan(0.001);
  });
});

// ── Quote vs Estimate Sanity (via Guardian) ──────────────────────────────

describe("quote vs estimate sanity check", () => {
  it("Guardian passes when quote within 25% of estimate median", () => {
    const ctx = makeDealCtx();
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 280,
        positioning: null,
        calculatedAt: new Date().toISOString(),
      },
      quote: {
        operatorPrice: 28000,
        osaPrice: 30435,
        margin: 0.08,
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
        aircraft: null,
        quotedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterQuote(ctx);
    const sanityCheck = checks.find((c) => c.name === "quote_vs_estimate");
    expect(sanityCheck).toBeDefined();
    expect(sanityCheck!.passed).toBe(true);
    // 28000 vs median 30000 = 6.7% off
    expect(sanityCheck!.message).toContain("within");
  });

  it("Guardian warns when quote more than 25% off estimate", () => {
    const ctx = makeDealCtx();
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 280,
        positioning: null,
        calculatedAt: new Date().toISOString(),
      },
      quote: {
        operatorPrice: 42000, // 40% above median of 30000
        osaPrice: 45652,
        margin: 0.08,
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
        aircraft: null,
        quotedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterQuote(ctx);
    const sanityCheck = checks.find((c) => c.name === "quote_vs_estimate");
    expect(sanityCheck!.severity).toBe("warning");
    expect(sanityCheck!.message).toContain("40%");
  });

  it("Guardian warns when margin below policy minimum", () => {
    const ctx = makeDealCtx();
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 280,
        positioning: null,
        calculatedAt: new Date().toISOString(),
      },
      quote: {
        operatorPrice: 28000,
        osaPrice: 29120, // ~4% margin
        margin: 0.04,
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
        aircraft: null,
        quotedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterQuote(ctx);
    const marginCheck = checks.find((c) => c.name === "margin_policy");
    expect(marginCheck!.severity).toBe("warning");
    expect(marginCheck!.message).toContain("below minimum");
  });

  it("Guardian warns when margin above policy maximum", () => {
    const ctx = makeDealCtx();
    updateDealContext(ctx, {
      estimate: {
        source: "aviapages",
        flightTime: 150,
        priceRange: { low: 25000, high: 35000 },
        fuelBurn: 280,
        positioning: null,
        calculatedAt: new Date().toISOString(),
      },
      quote: {
        operatorPrice: 28000,
        osaPrice: 37333, // ~25% margin
        margin: 0.25,
        validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
        aircraft: null,
        quotedAt: new Date().toISOString(),
      },
    });

    const checks = checksAfterQuote(ctx);
    const marginCheck = checks.find((c) => c.name === "margin_policy");
    expect(marginCheck!.severity).toBe("warning");
    expect(marginCheck!.message).toContain("above maximum");
  });
});

// ── Learning Loop: Estimate Delta ────────────────────────────────────────

describe("calcEstimateDelta", () => {
  it("calculates positive delta (actual above estimate)", () => {
    const delta = calcEstimateDelta({ low: 25000, high: 35000 }, 33600);
    // median = 30000, delta = (33600 - 30000) / 30000 = 0.12
    expect(delta).toBeCloseTo(0.12, 2);
  });

  it("calculates negative delta (actual below estimate)", () => {
    const delta = calcEstimateDelta({ low: 25000, high: 35000 }, 27000);
    // median = 30000, delta = (27000 - 30000) / 30000 = -0.10
    expect(delta).toBeCloseTo(-0.10, 2);
  });

  it("returns 0 when actual equals estimate median", () => {
    const delta = calcEstimateDelta({ low: 25000, high: 35000 }, 30000);
    expect(delta).toBe(0);
  });

  it("handles zero median gracefully", () => {
    const delta = calcEstimateDelta({ low: 0, high: 0 }, 10000);
    expect(delta).toBe(0);
  });
});

// ── End-to-End: Estimate + Quote ─────────────────────────────────────────

describe("end-to-end: estimate then quote", () => {
  it("full flow: estimate → budget check → quote → Guardian", async () => {
    // Step 1: Get estimate
    const apiResult: PriceEstimateResult = { low: 25000, high: 35000, flightTime: 150, fuelBurn: 280 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx({ budgetMin: 25000, budgetMax: 40000 });

    const estResult = await estimate(ctx, { aviapages: client });
    updateDealContext(ctx, { estimate: estResult.estimate });

    // Step 2: Budget check
    const budgetIssue = checkBudgetFit(ctx.client.budget, ctx.estimate.priceRange);
    expect(budgetIssue).toBeNull(); // budget fits

    // Step 3: Guardian validates estimate
    const estChecks = checksAfterEstimate(ctx);
    const estFailed = estChecks.filter((c) => !c.passed && c.severity === "critical");
    expect(estFailed).toHaveLength(0);

    // Step 4: Real quote comes in
    const quoteResult = await quote(ctx, {
      operatorPrice: 28000,
      aircraft: { type: "Phenom 300E", tail: "N300TE", year: 2022 },
    });
    updateDealContext(ctx, { quote: quoteResult.quote });

    // Step 5: Guardian validates quote
    const quoteChecks = checksAfterQuote(ctx);
    const quoteFailed = quoteChecks.filter((c) => !c.passed && c.severity === "critical");
    expect(quoteFailed).toHaveLength(0);

    // Verify final state
    expect(ctx.estimate.priceRange!.low).toBe(25000);
    expect(ctx.estimate.priceRange!.high).toBe(35000);
    expect(ctx.quote.operatorPrice).toBe(28000);
    expect(ctx.quote.osaPrice).toBe(Math.round(28000 / 0.92));
    expect(ctx.quote.margin).toBe(0.08);

    // Learning loop delta
    const delta = calcEstimateDelta(ctx.estimate.priceRange!, ctx.quote.operatorPrice!);
    expect(delta).toBeCloseTo(-0.067, 2); // 28000 vs median 30000
  });

  it("budget mismatch stops pipeline before operator contact", async () => {
    const apiResult: PriceEstimateResult = { low: 50000, high: 70000, flightTime: 240, fuelBurn: 500 };
    const client = new AviapagesClient({ apiKey: "test" }, mockFetch(apiResult));
    const ctx = makeDealCtx({ budgetMin: 20000, budgetMax: 35000 });

    const estResult = await estimate(ctx, { aviapages: client });
    updateDealContext(ctx, { estimate: estResult.estimate });

    // Budget check fails
    const budgetIssue = checkBudgetFit(ctx.client.budget, ctx.estimate.priceRange);
    expect(budgetIssue).not.toBeNull();
    expect(budgetIssue).toContain("35,000");
    expect(budgetIssue).toContain("50,000");

    // Guardian also catches it
    const checks = checksAfterEstimate(ctx);
    const budgetCheck = checks.find((c) => c.name === "budget_overlap");
    expect(budgetCheck!.passed).toBe(false);
    expect(budgetCheck!.severity).toBe("critical");
  });
});
