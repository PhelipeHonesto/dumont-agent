/**
 * ContextFactory — builds stage-specific context slices from DealContext.
 *
 * Replaces the pattern of passing structuredClone(entireDealContext) to every
 * capability. Each stage gets ONLY what it needs — typed, strict, no optional
 * catchall fields.
 *
 * Rules:
 * - Pure TypeScript. No LLM calls.
 * - Guardian passes older than the last 3 are trimmed.
 * - laneHistory does not leak past sourcing.
 * - RouteIntel and OperatorProfile are injected from pre-aggregated stores.
 */

import type { DealContext, GuardianPass } from "../schemas/deal-context.js";
import type { RouteIntel, OperatorProfile, ClientProfile } from "../schemas/composite-objects.js";
import type { RouteIntelStore } from "../memory/composite-stores.js";
import type { OperatorProfileStore } from "../memory/composite-stores.js";
import type { ClientProfileStore } from "../memory/composite-stores.js";

// ── Stage Context Types ─────────────────────────────────────────────────

export interface IntakeContext {
  rawMessage: string;
  clientHistory: ClientProfile | null;
}

export interface GuardianContext {
  stage: string;
  trip: {
    departure: string;
    arrival: string;
    date: string;
    pax: number;
    aircraftClass: string | null;
    aircraftType: string | null;
    isRoundTrip: boolean;
    specialRequirements: string[];
  };
  recentGuardianPasses: GuardianPass[];
  currentStatus: string;
  blockReason: string | null;
  clientBudget: { min: number; max: number } | null;
  estimate: {
    priceRange: { low: number; high: number } | null;
    flightTime: number | null;
  } | null;
  selectedOperator: {
    operatorName: string;
    baseAirport: string;
    aircraftType: string;
  } | null;
  quote: {
    operatorPrice: number | null;
    osaPrice: number | null;
    margin: number | null;
    validUntil: string | null;
  } | null;
}

export interface EstimateContext {
  trip: {
    departure: string;
    arrival: string;
    date: string;
    pax: number;
    aircraftClass: string | null;
    aircraftType: string | null;
  };
  routeIntel: RouteIntel | null;
}

export interface PriceWallContext {
  trip: {
    departure: string;
    arrival: string;
    date: string;
    pax: number;
  };
  physicsEstimate: { low: number; high: number } | null;
  clientBudget: { min: number; max: number } | null;
}

export interface SourcingContext {
  trip: {
    departure: string;
    arrival: string;
    date: string;
    pax: number;
    aircraftClass: string | null;
  };
  routeIntel: RouteIntel | null;
  operatorProfiles: OperatorProfile[];
  budgetCeiling: number | null;
}

export interface QuoteContext {
  trip: {
    departure: string;
    arrival: string;
    date: string;
    pax: number;
    aircraftClass: string | null;
  };
  routeIntel: RouteIntel | null;
  selectedOperator: {
    operatorName: string;
    baseAirport: string;
    aircraftType: string;
    score: number;
  } | null;
  clientBudget: { min: number; max: number } | null;
  ghostPositioningValue: number | null;
}

export interface PresentContext {
  route: string;
  clientName: string;
  osaPrice: number | null;
  trip: {
    departure: string;
    arrival: string;
    date: string;
    pax: number;
    aircraftClass: string | null;
  };
  aircraft: {
    type: string;
    tail: string;
    year: number;
  } | null;
}

export interface RespondContext {
  route: string;
  clientName: string;
  osaPrice: number | null;
  intent: string;
  dealStage: string;
}

// ── Store Dependencies ──────────────────────────────────────────────────

export interface ContextFactoryStores {
  routeIntel?: RouteIntelStore;
  operatorProfiles?: OperatorProfileStore;
  clientProfiles?: ClientProfileStore;
}

// ── Trim Helpers ────────────────────────────────────────────────────────

const MAX_RECENT_GUARDIAN_PASSES = 3;

function trimGuardianPasses(passes: GuardianPass[]): GuardianPass[] {
  if (passes.length <= MAX_RECENT_GUARDIAN_PASSES) return passes;
  return passes.slice(-MAX_RECENT_GUARDIAN_PASSES);
}

function routeKey(departure: string, arrival: string): string {
  return `${departure}-${arrival}`;
}

// ── Factory Functions ───────────────────────────────────────────────────

export function buildIntakeContext(
  rawMessage: string,
  stores?: ContextFactoryStores,
  clientNameOrEmail?: string,
): IntakeContext {
  const clientHistory = clientNameOrEmail && stores?.clientProfiles
    ? stores.clientProfiles.get(clientNameOrEmail)
    : null;
  return { rawMessage, clientHistory };
}

export function buildGuardianContext(
  stage: string,
  ctx: DealContext,
): GuardianContext {
  return {
    stage,
    trip: { ...ctx.trip },
    recentGuardianPasses: trimGuardianPasses(ctx.guardian.passes),
    currentStatus: ctx.guardian.currentStatus,
    blockReason: ctx.guardian.blockReason,
    clientBudget: ctx.client.budget ? { ...ctx.client.budget } : null,
    estimate: ctx.estimate.priceRange
      ? { priceRange: { ...ctx.estimate.priceRange }, flightTime: ctx.estimate.flightTime }
      : null,
    selectedOperator: ctx.sourcing.selectedOperator
      ? {
          operatorName: ctx.sourcing.selectedOperator.operatorName,
          baseAirport: ctx.sourcing.selectedOperator.baseAirport,
          aircraftType: ctx.sourcing.selectedOperator.aircraftType,
        }
      : null,
    quote: ctx.quote.operatorPrice !== null
      ? {
          operatorPrice: ctx.quote.operatorPrice,
          osaPrice: ctx.quote.osaPrice,
          margin: ctx.quote.margin,
          validUntil: ctx.quote.validUntil,
        }
      : null,
  };
}

export function buildEstimateContext(
  ctx: DealContext,
  stores?: ContextFactoryStores,
): EstimateContext {
  const route = routeKey(ctx.trip.departure, ctx.trip.arrival);
  const routeIntel = ctx.trip.aircraftClass && stores?.routeIntel
    ? stores.routeIntel.get(route, ctx.trip.aircraftClass)
    : null;
  return {
    trip: {
      departure: ctx.trip.departure,
      arrival: ctx.trip.arrival,
      date: ctx.trip.date,
      pax: ctx.trip.pax,
      aircraftClass: ctx.trip.aircraftClass,
      aircraftType: ctx.trip.aircraftType,
    },
    routeIntel,
  };
}

export function buildPriceWallContext(ctx: DealContext): PriceWallContext {
  return {
    trip: {
      departure: ctx.trip.departure,
      arrival: ctx.trip.arrival,
      date: ctx.trip.date,
      pax: ctx.trip.pax,
    },
    physicsEstimate: ctx.estimate.priceRange ? { ...ctx.estimate.priceRange } : null,
    clientBudget: ctx.client.budget ? { ...ctx.client.budget } : null,
  };
}

export function buildSourcingContext(
  ctx: DealContext,
  stores?: ContextFactoryStores,
): SourcingContext {
  const route = routeKey(ctx.trip.departure, ctx.trip.arrival);
  const routeIntel = ctx.trip.aircraftClass && stores?.routeIntel
    ? stores.routeIntel.get(route, ctx.trip.aircraftClass)
    : null;

  const operatorProfiles = routeIntel?.topOperators && stores?.operatorProfiles
    ? stores.operatorProfiles.getMany(routeIntel.topOperators)
    : [];

  return {
    trip: {
      departure: ctx.trip.departure,
      arrival: ctx.trip.arrival,
      date: ctx.trip.date,
      pax: ctx.trip.pax,
      aircraftClass: ctx.trip.aircraftClass,
    },
    routeIntel,
    operatorProfiles,
    budgetCeiling: ctx.client.budget?.max ?? null,
  };
}

export function buildQuoteContext(
  ctx: DealContext,
  stores?: ContextFactoryStores,
): QuoteContext {
  const route = routeKey(ctx.trip.departure, ctx.trip.arrival);
  const routeIntel = ctx.trip.aircraftClass && stores?.routeIntel
    ? stores.routeIntel.get(route, ctx.trip.aircraftClass)
    : null;

  const ghostPositioningValue = ctx.sourcing.selectedOperator
    ? ctx.sourcing.selectedOperator.distanceToDeparture
    : null;

  return {
    trip: {
      departure: ctx.trip.departure,
      arrival: ctx.trip.arrival,
      date: ctx.trip.date,
      pax: ctx.trip.pax,
      aircraftClass: ctx.trip.aircraftClass,
    },
    routeIntel,
    selectedOperator: ctx.sourcing.selectedOperator
      ? {
          operatorName: ctx.sourcing.selectedOperator.operatorName,
          baseAirport: ctx.sourcing.selectedOperator.baseAirport,
          aircraftType: ctx.sourcing.selectedOperator.aircraftType,
          score: ctx.sourcing.selectedOperator.score,
        }
      : null,
    clientBudget: ctx.client.budget ? { ...ctx.client.budget } : null,
    ghostPositioningValue,
  };
}

export function buildPresentContext(ctx: DealContext): PresentContext {
  return {
    route: routeKey(ctx.trip.departure, ctx.trip.arrival),
    clientName: ctx.client.name,
    osaPrice: ctx.quote.osaPrice,
    trip: {
      departure: ctx.trip.departure,
      arrival: ctx.trip.arrival,
      date: ctx.trip.date,
      pax: ctx.trip.pax,
      aircraftClass: ctx.trip.aircraftClass,
    },
    aircraft: ctx.quote.aircraft ? { ...ctx.quote.aircraft } : null,
  };
}

export function buildRespondContext(
  ctx: DealContext,
  intent: string,
): RespondContext {
  return {
    route: routeKey(ctx.trip.departure, ctx.trip.arrival),
    clientName: ctx.client.name,
    osaPrice: ctx.quote.osaPrice,
    intent,
    dealStage: ctx.stage,
  };
}
