/**
 * Composite Objects — pre-aggregated intelligence that accumulates from deals.
 *
 * These are NOT throwaway caches. They are permanent business objects that
 * power pricing, sourcing, and client personalization. They also serve as
 * the foundation for future payment infrastructure and financial products.
 *
 * Updated via hooks in the learning loop on every deal close or interaction.
 * Start empty. Accumulate from real deals only. No mock data.
 */

import { z } from "zod";
import { AircraftClass, DealMode } from "./deal-context.js";

// ── RouteIntel ──────────────────────────────────────────────────────────
// Cached per route + aircraft class. TTL: 24 hours with manual refresh.
// Powers quote pre-calculation. avgMarginDelta = Operator Margin Index.

export const RouteIntelSchema = z.object({
  route: z.string(),                     // "KTEB-KMIA"
  aircraftClass: AircraftClass,
  avgPrice30d: z.number().nullable(),
  dealCount: z.number().int().nonnegative(),
  demandTrend: z.enum(["rising", "falling", "stable"]),
  topOperators: z.array(z.string()),     // top 3 by reliability score on this route
  seasonalFactor: z.number(),            // multiplier, 1.0 = baseline
  avgMarginDelta: z.number(),            // physics estimate vs actual quote spread
  lastUpdated: z.string().datetime(),
});
export type RouteIntel = z.infer<typeof RouteIntelSchema>;

// ── OperatorProfile ─────────────────────────────────────────────────────
// Cached per operator. Updated on every interaction.
// Powers sourcing. homeBase is critical for ghost positioning calc.

export const OperatorProfileSchema = z.object({
  name: z.string(),
  homeBase: z.string(),                  // ICAO — overnight-parking-inferred from ADS-B
  certs: z.array(z.string()),
  fleet: z.array(z.string()),
  avgResponseTime: z.number(),           // minutes
  reliabilityScore: z.number().min(0).max(1),  // Bayesian with time decay
  pricingDelta: z.number(),              // typical markup over physics cost
  paymentSpeed: z.number(),              // avg days to process payment
  quoteToBookRate: z.number().min(0).max(1),
  cancelRate: z.number().min(0).max(1),
  dealCount: z.number().int().nonnegative(),
  lastUpdated: z.string().datetime(),
});
export type OperatorProfile = z.infer<typeof OperatorProfileSchema>;

// ── ClientProfile ───────────────────────────────────────────────────────
// Cached per client. Updated on every deal.
// Powers personalization. totalSpend triggers advisory at $400K+.

export const ClientDealHistoryEntrySchema = z.object({
  route: z.string(),
  price: z.number(),
  date: z.string(),
  outcome: z.string(),
});
export type ClientDealHistoryEntry = z.infer<typeof ClientDealHistoryEntrySchema>;

export const ClientProfileSchema = z.object({
  name: z.string(),
  email: z.string(),
  dealHistory: z.array(ClientDealHistoryEntrySchema),
  avgPaymentTime: z.number(),            // hours from invoice to payment
  totalSpend: z.number(),
  tripFrequency: z.number(),             // trips per year
  preferredAircraftClass: AircraftClass.nullable(),
  preferredRoutes: z.array(z.string()),
  lastUpdated: z.string().datetime(),
});
export type ClientProfile = z.infer<typeof ClientProfileSchema>;

// ── ValidationLedger ────────────────────────────────────────────────────
// Append-only. One row per deal attempt — booked or lost.
// The artifact shown to YC proving unit economics, quote velocity,
// and operator signal quality.

export const ValidationLedgerEntrySchema = z.object({
  // Identity
  route: z.string(),
  date: z.string(),
  mode: DealMode,

  // Benchmark 1: Ghost Positioning Spread
  ghostValueCents: z.number().default(0),
  ghostDescription: z.string().optional(),

  // Benchmark 2: Operator Signal Ratio (keep existing rfqsSent/quotesReceived)
  rfqsSent: z.number().int().nonnegative().default(0),
  quotesReceived: z.number().int().nonnegative().default(0),

  // Benchmark 3: Route Liquidity Index
  rliAtQuote: z.enum(["high", "medium", "low"]).default("low"),
  rliScore: z.number().optional(),

  // Benchmark 4: Fleet Resilience
  tripOutcome: z.enum(["completed", "disruption_recovered", "disruption_failed", "cancelled"]).default("completed"),
  fleetResilienceUsed: z.boolean().default(false),
  recoveryTimeMin: z.number().optional(),

  // Benchmark 5: Demand Prediction
  routePageViews7d: z.number().optional(),

  // Benchmark 6: Client Decision Velocity
  optionsPresentedAt: z.string().optional(),
  clientConfirmedAt: z.string().optional(),
  clientDecisionMinutes: z.number().nullable().default(null),

  // Benchmark 7: Network Density
  operatorsInNetwork: z.number().optional(),
  operatorsInMetro: z.number().optional(),

  // Timing
  leadTimeHours: z.number().default(0),

  // Pricing Engine Accuracy (integer cents)
  dumontPhysicsEstimate: z.number().nullable().default(null),
  ghostPositioningValue: z.number().nullable().default(null),
  operatorQuotedPrice: z.number().nullable().default(null),
  osaClientPrice: z.number().nullable().default(null),
  realizedMarginPct: z.number().nullable().default(null),
  estimateDeltaPercent: z.number().optional(),

  // Operator Intelligence
  operatorName: z.string().optional(),
  operatorBase: z.string().optional(),
  operatorResponseMinutes: z.number().nullable().default(null),
  operatorReliabilityScore: z.number().optional(),

  // Outcome
  outcome: z.enum(["booked", "lost_price", "lost_timing", "lost_ghosted", "lost_other", "cancelled"]).default("lost_other"),
  revenueCents: z.number().optional(),
  notes: z.string().default(""),

  // Payment State (Mercury flow)
  paymentStatus: z.enum(["pending", "invoiced", "client_paid", "operator_paid", "margin_captured"]).default("pending"),
  clientPaidAt: z.string().optional(),
  operatorPaidAt: z.string().optional(),
  floatWindowHours: z.number().optional(),

  // Legacy (kept for backward compat, mapped from tripOutcome)
  tripCompleted: z.boolean().nullable().default(null),

  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type ValidationLedgerEntry = z.infer<typeof ValidationLedgerEntrySchema>;
