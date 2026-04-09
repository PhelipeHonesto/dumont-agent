/**
 * Quote Capability — two-phase pricing pipeline.
 *
 * Phase 1 (estimate): Call Aviapages Price Calculator API, apply historical
 * delta correction from DealStore memory, write estimate to DealContext.
 * Guardian runs after to check budget overlap.
 *
 * Phase 2 (real quote): Accept operator price input, calculate OSA price
 * with margin from config, write quote to DealContext. Guardian runs after
 * to check quote vs estimate sanity and margin policy.
 *
 * Per spec: capabilities/quote.md
 */

import type { DealContext } from "../schemas/deal-context.js";
import type { EstimateResult, QuoteResult } from "../orchestrator/index.js";
import type { AviapagesClient, PriceEstimateResult } from "../integrations/aviapages.js";
import type { DealStore } from "../memory/deal-store.js";
import { MARGIN_POLICY, QUOTE_VALIDITY } from "../config.js";

// ── Phase 1: Estimate ────────────────────────────────────────────────────

export interface EstimateOptions {
  /** Aviapages client — null on cold start or if API unavailable. */
  aviapages: AviapagesClient | null;
  /** DealStore for historical delta correction. */
  dealStore?: DealStore | null;
}

/**
 * Phase 1: Generate a price estimate.
 *
 * 1. Call Aviapages Price Calculator API
 * 2. Apply historical delta correction from memory
 * 3. Write to DealContext estimate section
 *
 * If Aviapages is unavailable, returns estimate with source="manual" and null range.
 */
export async function estimate(
  ctx: DealContext,
  options: EstimateOptions,
): Promise<EstimateResult> {
  const { aviapages, dealStore = null } = options;
  const { trip } = ctx;

  // Call Aviapages
  let apiResult: PriceEstimateResult | null = null;
  if (aviapages && trip.departure && trip.arrival) {
    apiResult = await aviapages.getPriceEstimate({
      departure: trip.departure,
      arrival: trip.arrival,
      aircraftType: trip.aircraftType ?? undefined,
      date: trip.date,
      pax: trip.pax,
    });
  }

  if (!apiResult) {
    // API unavailable — return empty estimate
    return {
      estimate: {
        source: "manual",
        flightTime: null,
        priceRange: null,
        fuelBurn: null,
        positioning: null,
        calculatedAt: null,
      },
    };
  }

  // Apply historical delta correction
  let adjustedLow = apiResult.low;
  let adjustedHigh = apiResult.high;

  if (dealStore && trip.departure && trip.arrival) {
    const delta = dealStore.getPricingDelta(trip.departure, trip.arrival);
    if (delta !== null) {
      // delta is a fraction: +0.12 means Aviapages underestimates by 12%
      adjustedLow = Math.round(apiResult.low * (1 + delta));
      adjustedHigh = Math.round(apiResult.high * (1 + delta));
    }
  }

  return {
    estimate: {
      source: "aviapages",
      flightTime: apiResult.flightTime > 0 ? apiResult.flightTime : null,
      priceRange: { low: adjustedLow, high: adjustedHigh },
      fuelBurn: apiResult.fuelBurn > 0 ? apiResult.fuelBurn : null,
      positioning: null,
      calculatedAt: new Date().toISOString(),
    },
  };
}

// ── Phase 2: Real Quote ──────────────────────────────────────────────────

export interface QuoteInput {
  /** Operator's quoted price. */
  operatorPrice: number;
  /** Target margin as decimal (0.08 = 8%). Uses config default if not provided. */
  margin?: number;
  /** Quote validity in minutes. Uses config default if not provided. */
  validityMinutes?: number;
  /** Aircraft details from operator. */
  aircraft?: { type: string; tail: string; year: number } | null;
}

/**
 * Phase 2: Process a real operator quote.
 *
 * 1. Accept operator price
 * 2. Calculate OSA price = operatorPrice / (1 - margin)
 * 3. Set validity window
 * 4. Write to DealContext quote section
 */
export async function quote(
  _ctx: DealContext,
  input: QuoteInput,
): Promise<QuoteResult> {
  const rawMargin = input.margin ?? MARGIN_POLICY.target;
  // Hard bounds: prevent division by zero (margin=1.0), negative prices, and Infinity
  const margin = Math.max(0.01, Math.min(rawMargin, 0.50));
  const validityMinutes = input.validityMinutes ?? QUOTE_VALIDITY.defaultMinutes;

  // OSA price formula per spec: operatorPrice / (1 - margin%)
  // This ensures the margin is the percentage of the final price, not a markup on cost.
  // Example: operator $28,000 at 8% margin → $28,000 / 0.92 = $30,434.78
  const osaPrice = Math.round(input.operatorPrice / (1 - margin));

  const now = new Date();
  const validUntil = new Date(now.getTime() + validityMinutes * 60_000);

  return {
    quote: {
      operatorPrice: input.operatorPrice,
      osaPrice,
      margin,
      validUntil: validUntil.toISOString(),
      aircraft: input.aircraft ?? null,
      quotedAt: now.toISOString(),
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Check if client budget fits the estimate range.
 * Returns null if fit, or a reason string if budget mismatch.
 * Used by the orchestrator before advancing past the estimate stage.
 */
export function checkBudgetFit(
  budget: { min: number; max: number } | null,
  priceRange: { low: number; high: number } | null,
): string | null {
  if (!budget || !priceRange) return null; // can't check — proceed
  if (budget.max < priceRange.low) {
    return `Client budget ceiling $${budget.max.toLocaleString()} is below estimate floor $${priceRange.low.toLocaleString()}`;
  }
  return null;
}

/**
 * Calculate the estimate-vs-actual delta for learning loop.
 * Returns a fraction: +0.12 means actual was 12% above estimate median.
 */
export function calcEstimateDelta(
  estimateRange: { low: number; high: number },
  actualPrice: number,
): number {
  const median = (estimateRange.low + estimateRange.high) / 2;
  if (median === 0) return 0;
  return (actualPrice - median) / median;
}
