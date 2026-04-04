/**
 * Learning Loop — converts a completed DealContext into a DealRecord
 * and persists it to the DealStore.
 *
 * Per spec: learning-loop.md
 *
 * Every deal teaches the system. This module captures:
 * - Pricing intelligence (estimate vs actual delta)
 * - Operator intelligence (conversion, response time, pricing accuracy)
 * - Client intelligence (type, budget, conversion, decision speed)
 * - Pipeline intelligence (guardian flags, deal velocity, outcome)
 *
 * Called by the orchestrator's closeDeal() when a deal reaches
 * "closed" or "failed".
 */

import type { DealContext } from "../schemas/deal-context.js";
import type { DealRecord } from "../schemas/deal-record.js";
import type { DealStore } from "./deal-store.js";
import { calcEstimateDelta } from "../capabilities/quote.js";
import { haversine } from "../utils/haversine.js";

// ── Season Detection ─────────────────────────────────────────────────────

/**
 * Determine season from a date string.
 * - peak: Dec 15 – Jan 5, Presidents' Day week (Feb), Spring Break (Mar-Apr)
 * - shoulder: Oct-Nov, May-Jun
 * - off: Jul-Sep, Jan 6-31
 */
export function detectSeason(dateStr: string): "peak" | "shoulder" | "off" {
  if (!dateStr) return "off";
  // Parse date components directly to avoid UTC timezone shifts
  const parts = dateStr.split("-");
  if (parts.length < 3) return "off";
  const month = parseInt(parts[1]!, 10) - 1;  // 0-indexed
  const day = parseInt(parts[2]!, 10);

  // Dec 15 – Dec 31
  if (month === 11 && day >= 15) return "peak";
  // Jan 1 – Jan 5
  if (month === 0 && day <= 5) return "peak";
  // February (Presidents' Day week + ski season)
  if (month === 1) return "peak";
  // March-April (Spring Break)
  if (month === 2 || month === 3) return "peak";
  // Oct-Nov (shoulder — fall travel)
  if (month === 9 || month === 10) return "shoulder";
  // May-Jun (shoulder — early summer)
  if (month === 4 || month === 5) return "shoulder";
  // Jul-Sep, rest of Jan (off season)
  return "off";
}

// ── Route Distance ────────────────��──────────────────────────────────────

export interface AirportCoords {
  icao: string;
  latitude: number;
  longitude: number;
}

/**
 * Compute route distance in nm. Returns 0 if coordinates unavailable.
 */
export function computeRouteDistance(
  departure: string,
  arrival: string,
  airports?: Map<string, AirportCoords>,
): number {
  if (!airports) return 0;
  const dep = airports.get(departure);
  const arr = airports.get(arrival);
  if (!dep || !arr) return 0;
  return Math.round(haversine(dep.latitude, dep.longitude, arr.latitude, arr.longitude));
}

// ── Build DealRecord from DealContext ───────��─────────────────────────────

export type DealOutcomeResult =
  | "closed"
  | "lost_to_competition"
  | "client_declined"
  | "budget_mismatch"
  | "aircraft_unavailable"
  | "operator_no_response"
  | "expired";

export interface RecordDealOptions {
  /** The final deal outcome. */
  result: DealOutcomeResult;
  /** Operator response time in seconds (null if operator never contacted). */
  operatorResponseTime?: number | null;
  /** Airport coordinates for route distance calculation. */
  airports?: Map<string, AirportCoords>;
  /** Additional notes. */
  notes?: string;
}

/**
 * Build a DealRecord from a completed DealContext.
 *
 * Extracts all learning loop fields from the context:
 * - Route + distance
 * - Pricing: estimate range, operator quote, OSA price, estimate delta
 * - Operator: name, base, response time, whether they quoted (conversion)
 * - Client: name, contact, type, budget, whether they confirmed, decision time
 * - Outcome: result, revenue, margin
 * - Timing: total deal time, day of week, season
 * - Meta: guardian flag messages
 */
export function buildDealRecord(
  ctx: DealContext,
  options: RecordDealOptions,
): DealRecord {
  const { result, operatorResponseTime = null, airports } = options;
  const now = new Date();

  // Estimate delta — uses calcEstimateDelta from quote.ts
  let estimateDelta: number | null = null;
  if (ctx.estimate.priceRange && ctx.quote.operatorPrice) {
    estimateDelta = calcEstimateDelta(ctx.estimate.priceRange, ctx.quote.operatorPrice);
    estimateDelta = Math.round(estimateDelta * 10000) / 10000; // 4 decimal places
  }

  // Decision time: seconds from presentation to decision
  let decisionTime: number | null = null;
  if (ctx.presentation.sentAt && ctx.presentation.decisionAt) {
    decisionTime = Math.round(
      (new Date(ctx.presentation.decisionAt).getTime() - new Date(ctx.presentation.sentAt).getTime()) / 1000,
    );
  }

  // Revenue = OSA price - operator price
  let revenue: number | null = null;
  if (ctx.quote.osaPrice && ctx.quote.operatorPrice && result === "closed") {
    revenue = ctx.quote.osaPrice - ctx.quote.operatorPrice;
  }

  // Total deal time in seconds
  const totalDealTime = ctx.outcome.totalDealTime
    ?? Math.round((now.getTime() - new Date(ctx.createdAt).getTime()) / 1000);

  // Operator conversion: did they provide a quote?
  const operatorConversion = ctx.quote.operatorPrice !== null;

  // Client conversion: did the client confirm?
  const clientConversion = result === "closed";

  // Guardian flags: collect all warning/critical check messages
  const guardianFlags = ctx.guardian.passes.flatMap((pass) =>
    pass.checks
      .filter((c) => !c.passed || c.severity !== "info")
      .filter((c) => c.severity === "warning" || c.severity === "critical")
      .map((c) => `[${c.severity}] ${c.name}: ${c.message}`),
  );

  // Route distance
  const distance = computeRouteDistance(ctx.trip.departure, ctx.trip.arrival, airports);

  return {
    id: ctx.id,
    timestamp: now.toISOString(),
    mode: ctx.mode,

    route: {
      departure: ctx.trip.departure || "XXXX",
      arrival: ctx.trip.arrival || "XXXX",
      distance,
    },

    aviapagesEstimate: ctx.estimate.priceRange
      ? { low: ctx.estimate.priceRange.low, high: ctx.estimate.priceRange.high }
      : null,
    operatorQuote: ctx.quote.operatorPrice,
    osaPrice: ctx.quote.osaPrice,
    estimateDelta,

    operatorName: ctx.sourcing.selectedOperator?.operatorName ?? null,
    operatorBase: ctx.sourcing.selectedOperator?.baseAirport ?? null,
    operatorResponseTime: operatorResponseTime ?? ctx.outcome.operatorResponseTime,
    operatorConversion,

    aircraftType: ctx.quote.aircraft?.type ?? ctx.sourcing.selectedOperator?.aircraftType ?? null,
    aircraftClass: ctx.trip.aircraftClass,

    clientName: ctx.client.name || null,
    clientContact: ctx.client.contact || null,
    clientType: ctx.client.type,
    clientBudget: ctx.client.budget,
    clientConversion,
    decisionTime,

    result,
    revenue,
    margin: ctx.quote.margin,

    totalDealTime,
    dayOfWeek: now.getDay(),
    season: detectSeason(ctx.trip.date),

    guardianFlags,
  };
}

// ── Write to Store ──────────────��────────────────────────────────────────

/**
 * Build a DealRecord and persist it to the DealStore.
 * Returns the record for inspection/logging.
 */
export function recordDeal(
  ctx: DealContext,
  dealStore: DealStore,
  options: RecordDealOptions,
): DealRecord {
  const record = buildDealRecord(ctx, options);
  dealStore.add(record);

  if (options.notes) ctx.outcome.notes = options.notes;

  return record;
}
