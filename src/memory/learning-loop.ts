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
import type {
  RouteIntel,
  OperatorProfile,
  ClientProfile,
  ValidationLedgerEntry,
} from "../schemas/composite-objects.js";
import type {
  RouteIntelStore,
  OperatorProfileStore,
  ClientProfileStore,
  ValidationLedgerStore,
} from "./composite-stores.js";
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

export interface CompositeStores {
  routeIntel?: RouteIntelStore;
  operatorProfiles?: OperatorProfileStore;
  clientProfiles?: ClientProfileStore;
  validationLedger?: ValidationLedgerStore;
}

export interface RecordDealOptions {
  /** The final deal outcome. */
  result: DealOutcomeResult;
  /** Operator response time in seconds (null if operator never contacted). */
  operatorResponseTime?: number | null;
  /** Airport coordinates for route distance calculation. */
  airports?: Map<string, AirportCoords>;
  /** Additional notes. */
  notes?: string;
  /** Composite object stores — updated on deal close if provided. */
  compositeStores?: CompositeStores;
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

// ── Composite Update Thresholds ──────────────────────────────────────────

/** Demand is "rising" if recent count exceeds prior by this factor. */
const DEMAND_RISING_THRESHOLD = 1.3;
/** Demand is "falling" if recent count is below prior by this factor. */
const DEMAND_FALLING_THRESHOLD = 0.7;
/** Bayesian confidence boost per 10 deals for reliability scoring. */
const RELIABILITY_CONFIDENCE_BOOST = 0.1;
/** Deals needed for full confidence in reliability scoring. */
const RELIABILITY_CONFIDENCE_DEALS = 10;

// ── Composite Object Update Functions ────────────────────────────────────

/**
 * Build or update RouteIntel from a deal record and existing store data.
 * Computes 30-day averages from all deals on this route.
 */
function updateRouteIntel(
  ctx: DealContext,
  record: DealRecord,
  dealStore: DealStore,
  store: RouteIntelStore,
): void {
  const route = `${ctx.trip.departure}-${ctx.trip.arrival}`;
  const aircraftClass = ctx.trip.aircraftClass;
  if (!aircraftClass) return;

  const routeDeals = dealStore.getByRoute(ctx.trip.departure, ctx.trip.arrival);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const recentDeals = routeDeals.filter((r) => r.timestamp >= thirtyDaysAgo);
  const pricedDeals = recentDeals.filter((r) => r.osaPrice !== null);

  const avgPrice30d = pricedDeals.length > 0
    ? Math.round(pricedDeals.reduce((sum, r) => sum + r.osaPrice!, 0) / pricedDeals.length)
    : null;

  // Demand trend: compare recent 15d vs prior 15d
  const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();
  const recent15 = recentDeals.filter((r) => r.timestamp >= fifteenDaysAgo).length;
  const prior15 = recentDeals.filter((r) => r.timestamp < fifteenDaysAgo).length;
  const demandTrend: "rising" | "falling" | "stable" =
    (prior15 === 0 && recent15 === 0) ? "stable" :
    recent15 > prior15 * DEMAND_RISING_THRESHOLD ? "rising" :
    recent15 < prior15 * DEMAND_FALLING_THRESHOLD ? "falling" : "stable";

  // Top 3 operators by closed deals on this route
  const operatorCounts = new Map<string, number>();
  for (const deal of routeDeals) {
    if (deal.operatorName && deal.result === "closed") {
      operatorCounts.set(deal.operatorName, (operatorCounts.get(deal.operatorName) ?? 0) + 1);
    }
  }
  const topOperators = [...operatorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  // Seasonal factor from current deal's season
  const season = record.season;
  const seasonalFactor = season === "peak" ? 1.25 : season === "shoulder" ? 1.10 : 1.0;

  // Average margin delta (physics estimate vs actual)
  const deltaDeals = routeDeals.filter((r) => r.estimateDelta !== null);
  const avgMarginDelta = deltaDeals.length > 0
    ? deltaDeals.reduce((sum, r) => sum + r.estimateDelta!, 0) / deltaDeals.length
    : 0;

  const intel: RouteIntel = {
    route,
    aircraftClass,
    avgPrice30d,
    dealCount: routeDeals.length,
    demandTrend,
    topOperators,
    seasonalFactor,
    avgMarginDelta: Math.round(avgMarginDelta * 10000) / 10000,
    lastUpdated: now.toISOString(),
  };

  store.upsert(intel);
}

/**
 * Build or update OperatorProfile from a deal record.
 * Incrementally updates running averages.
 */
function updateOperatorProfile(
  ctx: DealContext,
  _record: DealRecord,
  dealStore: DealStore,
  store: OperatorProfileStore,
): void {
  const operatorName = ctx.sourcing.selectedOperator?.operatorName;
  if (!operatorName) return;

  const existing = store.getIncludingStale(operatorName);
  const allDeals = dealStore.getByOperator(operatorName);
  const closedDeals = allDeals.filter((r) => r.result === "closed");
  const quotedDeals = allDeals.filter((r) => r.operatorConversion);
  const responseTimes = allDeals
    .filter((r) => r.operatorResponseTime !== null)
    .map((r) => r.operatorResponseTime!);
  const deltaDeals = allDeals.filter((r) => r.estimateDelta !== null);

  const avgResponseTime = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length / 60) // sec → min
    : 0;

  const reliabilityScore = allDeals.length > 0
    ? Math.min(closedDeals.length / allDeals.length + RELIABILITY_CONFIDENCE_BOOST * Math.min(allDeals.length / RELIABILITY_CONFIDENCE_DEALS, 1), 1)
    : 0;

  const pricingDelta = deltaDeals.length > 0
    ? deltaDeals.reduce((sum, r) => sum + r.estimateDelta!, 0) / deltaDeals.length
    : 0;

  const quoteToBookRate = quotedDeals.length > 0
    ? closedDeals.length / quotedDeals.length
    : 0;

  const profile: OperatorProfile = {
    name: operatorName,
    homeBase: existing?.homeBase ?? ctx.sourcing.selectedOperator?.baseAirport ?? "",
    certs: existing?.certs ?? [],
    fleet: existing?.fleet ?? [],
    avgResponseTime,
    reliabilityScore: Math.round(reliabilityScore * 1000) / 1000,
    pricingDelta: Math.round(pricingDelta * 10000) / 10000,
    paymentSpeed: existing?.paymentSpeed ?? 0,
    quoteToBookRate: Math.round(quoteToBookRate * 1000) / 1000,
    cancelRate: existing?.cancelRate ?? 0,
    dealCount: allDeals.length,
    lastUpdated: new Date().toISOString(),
  };

  store.upsert(profile);
}

/**
 * Build or update ClientProfile from a deal.
 */
function updateClientProfile(
  ctx: DealContext,
  _record: DealRecord,
  dealStore: DealStore,
  store: ClientProfileStore,
): void {
  const clientName = ctx.client.name;
  const clientEmail = ctx.client.contact;
  if (!clientName && !clientEmail) return;

  const existing = store.get(clientEmail || clientName);
  const allClientDeals = dealStore.findClientDeals(clientEmail || clientName);
  const closedDeals = allClientDeals.filter((r) => r.result === "closed");

  const totalSpend = closedDeals.reduce((sum, r) => sum + (r.osaPrice ?? 0), 0);

  // Trip frequency: deals per year (based on earliest deal)
  const timestamps = allClientDeals.map((r) => new Date(r.timestamp).getTime());
  const earliest = Math.min(...timestamps);
  const yearSpan = Math.max((Date.now() - earliest) / (365.25 * 24 * 60 * 60 * 1000), 1 / 12);
  const tripFrequency = Math.round((allClientDeals.length / yearSpan) * 10) / 10;

  // Preferred aircraft class: most common
  const classCounts = new Map<string, number>();
  for (const deal of allClientDeals) {
    if (deal.aircraftClass) {
      classCounts.set(deal.aircraftClass, (classCounts.get(deal.aircraftClass) ?? 0) + 1);
    }
  }
  const preferredAircraftClass = classCounts.size > 0
    ? [...classCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0] as ClientProfile["preferredAircraftClass"]
    : null;

  // Preferred routes: top 3
  const routeCounts = new Map<string, number>();
  for (const deal of allClientDeals) {
    const dealRoute = `${deal.route.departure}-${deal.route.arrival}`;
    routeCounts.set(dealRoute, (routeCounts.get(dealRoute) ?? 0) + 1);
  }
  const preferredRoutes = [...routeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([r]) => r);

  const dealHistory = allClientDeals.slice(-20).map((r) => ({
    route: `${r.route.departure}-${r.route.arrival}`,
    price: r.osaPrice ?? 0,
    date: r.timestamp.slice(0, 10),
    outcome: r.result,
  }));

  const profile: ClientProfile = {
    name: clientName || existing?.name || "",
    email: clientEmail || existing?.email || "",
    dealHistory,
    avgPaymentTime: existing?.avgPaymentTime ?? 0,
    totalSpend,
    tripFrequency,
    preferredAircraftClass,
    preferredRoutes,
    lastUpdated: new Date().toISOString(),
  };

  store.upsert(profile);
}

/**
 * Append a ValidationLedger entry from a completed deal.
 */
function appendValidationLedger(
  ctx: DealContext,
  record: DealRecord,
  store: ValidationLedgerStore,
): void {
  const route = `${ctx.trip.departure}-${ctx.trip.arrival}`;

  // Lead time: hours from deal creation to trip date
  const tripDate = new Date(ctx.trip.date).getTime();
  const createdAt = new Date(ctx.createdAt).getTime();
  const leadTimeHours = Math.round((tripDate - createdAt) / (60 * 60 * 1000));

  // RLI: based on operator response (proxy for route liquidity)
  const rliAtQuote: "high" | "medium" | "low" =
    record.route.distance > 0 && record.operatorConversion ? "high" :
    record.operatorConversion ? "medium" : "low";

  // Map deal outcome to ledger outcome
  const outcomeMap: Record<string, ValidationLedgerEntry["outcome"]> = {
    closed: "booked",
    client_declined: "lost_price",
    budget_mismatch: "lost_price",
    lost_to_competition: "lost_price",
    expired: "lost_timing",
    operator_no_response: "lost_ghosted",
    aircraft_unavailable: "lost_other",
  };

  const physicsEstimate = ctx.estimate.priceRange
    ? Math.round((ctx.estimate.priceRange.low + ctx.estimate.priceRange.high) / 2)
    : null;

  const realizedMarginPct = ctx.quote.osaPrice && ctx.quote.operatorPrice && ctx.quote.osaPrice > 0
    ? Math.round(((ctx.quote.osaPrice - ctx.quote.operatorPrice) / ctx.quote.osaPrice) * 10000) / 100
    : null;

  const clientDecisionMinutes = record.decisionTime !== null
    ? Math.round(record.decisionTime / 60)
    : null;

  const entry: ValidationLedgerEntry = {
    route,
    date: ctx.trip.date || new Date().toISOString().slice(0, 10),
    mode: ctx.mode,
    leadTimeHours,
    rliAtQuote,
    dumontPhysicsEstimate: physicsEstimate,
    ghostPositioningValue: ctx.estimate.positioning,
    operatorQuotedPrice: ctx.quote.operatorPrice,
    osaClientPrice: ctx.quote.osaPrice,
    realizedMarginPct,
    rfqsSent: 1, // Always 1 per spec (one quote, one operator)
    quotesReceived: ctx.quote.operatorPrice !== null ? 1 : 0,
    operatorResponseMinutes: record.operatorResponseTime !== null
      ? Math.round(record.operatorResponseTime / 60)
      : null,
    clientDecisionMinutes,
    outcome: outcomeMap[record.result] ?? "lost_other",
    fleetResilienceUsed: ctx.sourcing.backupOperator !== null &&
      ctx.sourcing.selectedOperator?.operatorName !== record.operatorName,
    tripCompleted: record.result === "closed" ? null : false,
    notes: record.guardianFlags.join("; ") || "",
  };

  store.append(entry);
}

/**
 * Build a DealRecord and persist it to the DealStore.
 * Also updates composite objects (RouteIntel, OperatorProfile, ClientProfile,
 * ValidationLedger) if stores are provided.
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

  // Update composite objects if stores are provided.
  // Wrapped in try/catch — composite updates are best-effort.
  // A store write failure should not crash the deal pipeline.
  const stores = options.compositeStores;
  if (stores) {
    try {
      if (stores.routeIntel) {
        updateRouteIntel(ctx, record, dealStore, stores.routeIntel);
      }
      if (stores.operatorProfiles) {
        updateOperatorProfile(ctx, record, dealStore, stores.operatorProfiles);
      }
      if (stores.clientProfiles) {
        updateClientProfile(ctx, record, dealStore, stores.clientProfiles);
      }
      if (stores.validationLedger) {
        appendValidationLedger(ctx, record, stores.validationLedger);
      }
    } catch (err) {
      console.warn(
        `[learning-loop] Composite store update failed for deal ${ctx.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return record;
}
