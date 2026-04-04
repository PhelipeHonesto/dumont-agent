/**
 * Deal Context — single source of truth for every deal in the pipeline.
 *
 * This is the new Dumont Agent schema, rebuilt from the orchestrator spec.
 * The old simulator had 5 independent agent sections; this schema follows
 * the spec's unified DealContext interface with Guardian as continuous
 * validation, not a final checkpoint.
 *
 * Key changes from simulator:
 * - Stages match the new pipeline: intake → qualified → estimated → sourced → quoted → presented → confirmed → closed → failed
 * - Client section includes budget + qualification (new)
 * - Guardian is an array of passes (runs at every stage), not a single section
 * - Estimate section uses Aviapages API (new)
 * - Sourcing selects ONE operator + ONE backup (was top-3)
 * - Quote captures real operator price + OSA margin (was formula-based)
 * - Presentation tracks client decision + timer (new)
 * - Outcome captures learning loop data (new)
 */

import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────────

export const DealMode = z.enum(["sim", "live"]);
export type DealMode = z.infer<typeof DealMode>;

export const DealStage = z.enum([
  "intake",
  "qualified",
  "estimated",
  "sourced",
  "quoted",
  "presented",
  "confirmed",
  "closed",
  "failed",
]);
export type DealStage = z.infer<typeof DealStage>;

export const ClientType = z.enum(["new", "repeat"]);
export type ClientType = z.infer<typeof ClientType>;

export const SubstitutionPref = z.enum([
  "auto_within_10pct",
  "always_approve",
  "cancel_if_unavailable",
]);
export type SubstitutionPref = z.infer<typeof SubstitutionPref>;

export const AircraftClass = z.enum([
  "light",
  "midsize",
  "super_mid",
  "heavy",
  "ultra_long_range",
]);
export type AircraftClass = z.infer<typeof AircraftClass>;

export const EstimateSource = z.enum(["aviapages", "historical", "manual"]);
export type EstimateSource = z.infer<typeof EstimateSource>;

export const GuardianStatus = z.enum(["clear", "warning", "blocked"]);
export type GuardianStatus = z.infer<typeof GuardianStatus>;

export const CheckSeverity = z.enum(["info", "warning", "critical"]);
export type CheckSeverity = z.infer<typeof CheckSeverity>;

export const DealOutcome = z.enum([
  "closed",
  "lost_to_competition",
  "client_declined",
  "budget_mismatch",
  "aircraft_unavailable",
  "operator_no_response",
  "expired",
]);
export type DealOutcome = z.infer<typeof DealOutcome>;

export const ClientDecision = z.enum([
  "confirmed",
  "declined",
  "expired",
  "pending",
]);
export type ClientDecision = z.infer<typeof ClientDecision>;

// ── Sub-schemas ──────────────────────────────────────────────────────────

export const StageHistoryEntrySchema = z.object({
  stage: DealStage,
  timestamp: z.string().datetime(),
  duration: z.number().nonnegative().nullable(),
});
export type StageHistoryEntry = z.infer<typeof StageHistoryEntrySchema>;

export const BudgetSchema = z.object({
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ClientSchema = z.object({
  name: z.string(),
  contact: z.string(),
  type: ClientType,
  budget: BudgetSchema.nullable(),
  substitutionPref: SubstitutionPref.nullable(),
  qualified: z.boolean(),
  qualificationReason: z.string().nullable(),
});
export type Client = z.infer<typeof ClientSchema>;

export const TripSchema = z.object({
  departure: z.string(),                   // ICAO (4 chars when populated)
  arrival: z.string(),                     // ICAO (4 chars when populated)
  date: z.string(),                        // ISO date
  pax: z.number().int().nonnegative(),
  aircraftClass: AircraftClass.nullable(),
  aircraftType: z.string().nullable(),
  isRoundTrip: z.boolean(),
  specialRequirements: z.array(z.string()),
});
export type Trip = z.infer<typeof TripSchema>;

export const GuardianCheckSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  severity: CheckSeverity,
  message: z.string(),
  data: z.unknown().optional(),
});
export type GuardianCheck = z.infer<typeof GuardianCheckSchema>;

export const GuardianPassSchema = z.object({
  stage: z.string(),
  passed: z.boolean(),
  checks: z.array(GuardianCheckSchema),
  timestamp: z.string().datetime(),
});
export type GuardianPass = z.infer<typeof GuardianPassSchema>;

export const GuardianSectionSchema = z.object({
  passes: z.array(GuardianPassSchema),
  currentStatus: GuardianStatus,
  blockReason: z.string().nullable(),
});
export type GuardianSection = z.infer<typeof GuardianSectionSchema>;

export const PriceRangeSchema = z.object({
  low: z.number().nonnegative(),
  high: z.number().nonnegative(),
});
export type PriceRange = z.infer<typeof PriceRangeSchema>;

export const EstimateSchema = z.object({
  source: EstimateSource,
  flightTime: z.number().positive().nullable(),           // minutes
  priceRange: PriceRangeSchema.nullable(),
  fuelBurn: z.number().nonnegative().nullable(),
  positioning: z.number().nonnegative().nullable(),       // nm from operator base
  calculatedAt: z.string().datetime().nullable(),
});
export type Estimate = z.infer<typeof EstimateSchema>;

export const OperatorMatchSchema = z.object({
  operatorId: z.string(),
  operatorName: z.string(),
  phone: z.string().nullable(),
  baseAirport: z.string().length(4),    // ICAO
  aircraftType: z.string(),
  aircraftTail: z.string().nullable(),
  score: z.number().min(0).max(1),
  scoreBreakdown: z.object({
    proximity: z.number().min(0).max(1),
    laneHistory: z.number().min(0).max(1),
    responseTime: z.number().min(0).max(1),
    pricingAccuracy: z.number().min(0).max(1),
    relationship: z.number().min(0).max(1),
  }),
  distanceToDeparture: z.number().nonnegative(), // nm
});
export type OperatorMatch = z.infer<typeof OperatorMatchSchema>;

export const LaneRecordSchema = z.object({
  dealId: z.string(),
  operatorId: z.string(),
  route: z.string(),      // "KTEB-KPBI"
  quoted: z.boolean(),
  converted: z.boolean(),
  responseTimeSec: z.number().nullable(),
  priceDelta: z.number().nullable(),  // vs estimate
  date: z.string(),
});
export type LaneRecord = z.infer<typeof LaneRecordSchema>;

export const SourcingSectionSchema = z.object({
  selectedOperator: OperatorMatchSchema.nullable(),
  backupOperator: OperatorMatchSchema.nullable(),
  rankingReason: z.string(),
  laneHistory: z.array(LaneRecordSchema),
});
export type SourcingSection = z.infer<typeof SourcingSectionSchema>;

export const QuoteAircraftSchema = z.object({
  type: z.string(),
  tail: z.string(),
  year: z.number().int().positive(),
});
export type QuoteAircraft = z.infer<typeof QuoteAircraftSchema>;

export const QuoteSectionSchema = z.object({
  operatorPrice: z.number().nonnegative().nullable(),
  osaPrice: z.number().nonnegative().nullable(),
  margin: z.number().min(0).max(1).nullable(),
  validUntil: z.string().datetime().nullable(),
  aircraft: QuoteAircraftSchema.nullable(),
  quotedAt: z.string().datetime().nullable(),
});
export type QuoteSection = z.infer<typeof QuoteSectionSchema>;

export const PresentationSchema = z.object({
  sentAt: z.string().datetime().nullable(),
  viewedAt: z.string().datetime().nullable(),
  clientDecision: ClientDecision.nullable(),
  decisionAt: z.string().datetime().nullable(),
  timerStarted: z.string().datetime().nullable(),
});
export type Presentation = z.infer<typeof PresentationSchema>;

export const OutcomeSchema = z.object({
  result: DealOutcome.nullable(),
  estimateVsActual: z.number().nullable(),       // percentage delta
  operatorResponseTime: z.number().nullable(),   // seconds
  totalDealTime: z.number().nullable(),          // seconds
  revenue: z.number().nullable(),
  notes: z.string().nullable(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

// ── Deal Context ─────────────────────────────────────────────────────────

export const DealContextSchema = z.object({
  // Identity
  id: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  mode: DealMode,

  // Stage tracking
  stage: DealStage,
  stageHistory: z.array(StageHistoryEntrySchema),

  // Sections
  client: ClientSchema,
  trip: TripSchema,
  guardian: GuardianSectionSchema,
  estimate: EstimateSchema,
  sourcing: SourcingSectionSchema,
  quote: QuoteSectionSchema,
  presentation: PresentationSchema,
  outcome: OutcomeSchema,
});
export type DealContext = z.infer<typeof DealContextSchema>;
