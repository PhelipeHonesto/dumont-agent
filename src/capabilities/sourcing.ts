/**
 * Sourcing Capability — select ONE operator + ONE backup via lane intelligence.
 * Never blast RFQs. Targeted matching per the Cartage model.
 *
 * Per spec: capabilities/sourcing.md
 *
 * Ranking algorithm (5 weighted factors):
 *   1. Proximity     (30%) — haversine from operator base to departure
 *   2. Lane history  (25%) — conversion rate on this route via DealStore
 *   3. Response time  (15%) — average time to return a quote
 *   4. Pricing accuracy (15%) — how close quotes are to estimates
 *   5. Relationship   (15%) — total deals closed, trust level
 *
 * Day 1-10: No history → proximity + aircraft match dominate (defaults 0.5)
 * Day 10-50: Lane history starts weighting in
 * Day 50+: Full algorithm with all five factors
 *
 * Reference: ~/osa/simulator/src/agents/sourcing.ts (old top-5 ranker)
 * Key change: ONE primary + ONE backup (not top-5)
 */

import type { DealContext, OperatorMatch, LaneRecord } from "../schemas/deal-context.js";
import type { SourcingResult } from "../orchestrator/index.js";
import type { DealStore } from "../memory/deal-store.js";
import { haversine } from "../utils/haversine.js";
import { SOURCING_SCORING } from "../config.js";

// ── Scoring Weights (per spec) ───────────────────────────────────────────

export const WEIGHTS = {
  proximity: 0.30,
  laneHistory: 0.25,
  responseTime: 0.15,
  pricingAccuracy: 0.15,
  relationship: 0.15,
} as const;

/** Cold-start default for factors with no historical data. */
const COLD_START_DEFAULT = SOURCING_SCORING.coldStartDefault;

// ── Operator Directory Types ─────────────────────────────────────────────

/** Operator record from Aviapages Charter Directories API or internal CRM. */
export interface OperatorRecord {
  operatorId: string;
  operatorName: string;
  phone: string | null;
  baseAirport: string;        // ICAO
  baseLatitude: number;
  baseLongitude: number;
  aircraftType: string;
  aircraftTail: string | null;
  aircraftCategory: string;
  passengerCapacity: number;
  rangeNm: number;
}

/** Airport coordinates for proximity calculations. */
export interface AirportCoords {
  icao: string;
  latitude: number;
  longitude: number;
}

// ── Sourcing Options ─────────────────────────────────────────────────────

export interface SourcingOptions {
  /** Available operators (from Aviapages directory or internal CRM). */
  operators: OperatorRecord[];
  /** Departure airport coordinates for proximity scoring. */
  departureAirport: AirportCoords | null;
  /** DealStore for lane history, response time, pricing accuracy. */
  dealStore?: DealStore | null;
}

// ── Individual Scoring Functions ─────────────────────────────────────────

/**
 * Proximity score (30%): haversine distance from operator base to departure.
 * Closer = higher score.
 */
export function scoreProximity(
  op: OperatorRecord,
  departureAirport: AirportCoords | null,
): number {
  if (!departureAirport) return COLD_START_DEFAULT;

  const distance = haversine(
    op.baseLatitude, op.baseLongitude,
    departureAirport.latitude, departureAirport.longitude,
  );

  for (const tier of SOURCING_SCORING.proximity) {
    if (distance <= tier.maxNm) return tier.score;
  }
  return SOURCING_SCORING.proximityDefault;
}

/**
 * Lane history score (25%): conversion rate on this specific route.
 * Higher conversion = higher score. No history = cold start default.
 */
export function scoreLaneHistory(
  operatorName: string,
  departure: string,
  arrival: string,
  dealStore: DealStore | null,
): number {
  if (!dealStore) return COLD_START_DEFAULT;

  const stats = dealStore.getOperatorStats(operatorName, departure, arrival);
  if (!stats || stats.totalDeals === 0) return COLD_START_DEFAULT;

  // Blend conversion rate with deal count confidence
  // More deals → more trust in the rate
  const confidence = Math.min(stats.totalDeals / SOURCING_SCORING.laneConfidenceThreshold, 1);
  const blended = COLD_START_DEFAULT * (1 - confidence) + stats.conversionRate * confidence;
  return Math.min(blended, 1.0);
}

/**
 * Response time score (15%): average time for operator to return a quote.
 * Faster = higher score. No history = cold start default.
 */
export function scoreResponseTime(
  operatorName: string,
  departure: string,
  arrival: string,
  dealStore: DealStore | null,
): number {
  if (!dealStore) return COLD_START_DEFAULT;

  const stats = dealStore.getOperatorStats(operatorName, departure, arrival);
  if (!stats || stats.avgResponseTime === 0) return COLD_START_DEFAULT;

  const avgSec = stats.avgResponseTime;

  for (const tier of SOURCING_SCORING.responseTime) {
    if (avgSec <= tier.maxSec) return tier.score;
  }
  return SOURCING_SCORING.responseTimeDefault;
}

/**
 * Pricing accuracy score (15%): how close operator quotes are to estimates.
 * Lower delta = higher score. No history = cold start default.
 */
export function scorePricingAccuracy(
  operatorName: string,
  departure: string,
  arrival: string,
  dealStore: DealStore | null,
): number {
  if (!dealStore) return COLD_START_DEFAULT;

  const deals = dealStore.getAll().filter(
    (r) =>
      r.operatorName === operatorName &&
      r.route.departure === departure &&
      r.route.arrival === arrival &&
      r.estimateDelta !== null,
  );

  if (deals.length === 0) return COLD_START_DEFAULT;

  const avgAbsDelta = deals.reduce((sum, r) => sum + Math.abs(r.estimateDelta!), 0) / deals.length;

  for (const tier of SOURCING_SCORING.pricingAccuracy) {
    if (avgAbsDelta <= tier.maxDelta) return tier.score;
  }
  return SOURCING_SCORING.pricingAccuracyDefault;
}

/**
 * Relationship score (15%): total deals closed, trust level.
 * More deals = more trust. No history = cold start default.
 */
export function scoreRelationship(
  operatorName: string,
  dealStore: DealStore | null,
): number {
  if (!dealStore) return COLD_START_DEFAULT;

  const deals = dealStore.getByOperator(operatorName);
  const closedDeals = deals.filter((r) => r.result === "closed");

  if (closedDeals.length === 0) return COLD_START_DEFAULT;

  const score = COLD_START_DEFAULT + Math.min(closedDeals.length / SOURCING_SCORING.relationshipMaxDeals, 0.5);
  return Math.min(score, 1.0);
}

// ── Composite Score ──────────────────────────────────────────────────────

export interface ScoredOperator {
  operator: OperatorRecord;
  score: number;
  breakdown: {
    proximity: number;
    laneHistory: number;
    responseTime: number;
    pricingAccuracy: number;
    relationship: number;
  };
  distanceToDeparture: number;
}

export function scoreOperator(
  op: OperatorRecord,
  departureAirport: AirportCoords | null,
  departure: string,
  arrival: string,
  dealStore: DealStore | null,
): ScoredOperator {
  const proximity = scoreProximity(op, departureAirport);
  const laneHistory = scoreLaneHistory(op.operatorName, departure, arrival, dealStore);
  const responseTime = scoreResponseTime(op.operatorName, departure, arrival, dealStore);
  const pricingAccuracy = scorePricingAccuracy(op.operatorName, departure, arrival, dealStore);
  const relationship = scoreRelationship(op.operatorName, dealStore);

  const composite =
    proximity * WEIGHTS.proximity +
    laneHistory * WEIGHTS.laneHistory +
    responseTime * WEIGHTS.responseTime +
    pricingAccuracy * WEIGHTS.pricingAccuracy +
    relationship * WEIGHTS.relationship;

  const distanceToDeparture = departureAirport
    ? haversine(op.baseLatitude, op.baseLongitude, departureAirport.latitude, departureAirport.longitude)
    : 0;

  return {
    operator: op,
    score: Math.round(composite * 1000) / 1000,
    breakdown: {
      proximity: Math.round(proximity * 100) / 100,
      laneHistory: Math.round(laneHistory * 100) / 100,
      responseTime: Math.round(responseTime * 100) / 100,
      pricingAccuracy: Math.round(pricingAccuracy * 100) / 100,
      relationship: Math.round(relationship * 100) / 100,
    },
    distanceToDeparture: Math.round(distanceToDeparture),
  };
}

// ── Convert to OperatorMatch ─────────────────────────────────────────────

function toOperatorMatch(scored: ScoredOperator): OperatorMatch {
  return {
    operatorId: scored.operator.operatorId,
    operatorName: scored.operator.operatorName,
    phone: scored.operator.phone,
    baseAirport: scored.operator.baseAirport,
    aircraftType: scored.operator.aircraftType,
    aircraftTail: scored.operator.aircraftTail,
    score: scored.score,
    scoreBreakdown: scored.breakdown,
    distanceToDeparture: scored.distanceToDeparture,
  };
}

// ── Lane History Records ─────────────────────────────────────────────────

function buildLaneHistory(
  departure: string,
  arrival: string,
  dealStore: DealStore | null,
): LaneRecord[] {
  if (!dealStore) return [];

  const route = `${departure}-${arrival}`;
  return dealStore.getByRoute(departure, arrival).map((r) => ({
    dealId: r.id,
    operatorId: r.operatorName ?? "unknown",
    route,
    quoted: r.operatorConversion,
    converted: r.result === "closed",
    responseTimeSec: r.operatorResponseTime,
    priceDelta: r.estimateDelta,
    date: r.timestamp.slice(0, 10),
  }));
}

// ── Main Entry Point ─────────────────────────────────────────────────────

/**
 * Select ONE primary operator + ONE backup for this deal.
 * Ranks all available operators, picks top two.
 * Backup is NEVER contacted unless primary falls through.
 */
export async function sourcing(
  ctx: DealContext,
  options: SourcingOptions,
): Promise<SourcingResult> {
  const { operators, departureAirport, dealStore = null } = options;
  const { departure, arrival, pax, aircraftClass } = ctx.trip;

  // Filter operators by basic viability
  const viable = operators.filter((op) => {
    // Must fit passenger count
    if (op.passengerCapacity < pax) return false;
    // Must match aircraft class if specified
    if (aircraftClass && op.aircraftCategory !== aircraftClass) return false;
    return true;
  });

  if (viable.length === 0) {
    return {
      sourcing: {
        selectedOperator: null,
        backupOperator: null,
        rankingReason: `No operators matched: ${operators.length} checked, none viable for ${pax} pax${aircraftClass ? ` in ${aircraftClass} class` : ""}`,
        laneHistory: buildLaneHistory(departure, arrival, dealStore),
      },
    };
  }

  // Score all viable operators
  const scored = viable.map((op) =>
    scoreOperator(op, departureAirport, departure, arrival, dealStore),
  );

  // Sort: highest score first, break ties by proximity (closer wins), then name
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.distanceToDeparture !== b.distanceToDeparture) {
      return a.distanceToDeparture - b.distanceToDeparture;
    }
    return a.operator.operatorName.localeCompare(b.operator.operatorName);
  });

  const primary = scored[0]!;
  // Backup is second-ranked — guaranteed different from primary
  const backup = scored.length > 1 ? scored[1]! : null;

  const hasHistory = dealStore ? dealStore.getByRoute(departure, arrival).length > 0 : false;
  const rankingBasis = hasHistory
    ? "Full algorithm: proximity + lane history + response time + pricing accuracy + relationship"
    : "Cold start: proximity + aircraft match (no lane history available)";

  return {
    sourcing: {
      selectedOperator: toOperatorMatch(primary),
      backupOperator: backup ? toOperatorMatch(backup) : null,
      rankingReason: `${primary.operator.operatorName} selected (score: ${primary.score}). ${rankingBasis}`,
      laneHistory: buildLaneHistory(departure, arrival, dealStore),
    },
  };
}
