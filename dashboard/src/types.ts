/**
 * Dashboard types — mirrors the Zod schemas from ../src/schemas/ as plain TS
 * interfaces. The dashboard consumes DealContext snapshots; it never imports
 * Zod at runtime to keep the bundle light.
 */

// ── DealContext (mirrors deal-context.ts) ────────────────────────────────

export type DealMode = "sim" | "live";

export type DealStage =
  | "intake" | "qualified" | "estimated" | "sourced"
  | "quoted" | "awaiting_review" | "presented" | "confirmed" | "closed" | "failed";

export type ClientType = "new" | "repeat";
export type SubstitutionPref = "auto_within_10pct" | "always_approve" | "cancel_if_unavailable";
export type AircraftClass = "light" | "midsize" | "super_mid" | "heavy" | "ultra_long_range";
export type GuardianStatus = "clear" | "warning" | "blocked";
export type CheckSeverity = "info" | "warning" | "critical";
export type ClientDecision = "confirmed" | "declined" | "expired" | "pending";

export interface GuardianCheck {
  name: string;
  passed: boolean;
  severity: CheckSeverity;
  message: string;
}

export interface GuardianPass {
  stage: string;
  passed: boolean;
  checks: GuardianCheck[];
  timestamp: string;
}

export interface OperatorMatch {
  operatorId: string;
  operatorName: string;
  phone: string | null;
  baseAirport: string;
  aircraftType: string;
  aircraftTail: string | null;
  score: number;
  scoreBreakdown: {
    proximity: number;
    laneHistory: number;
    responseTime: number;
    pricingAccuracy: number;
    relationship: number;
  };
  distanceToDeparture: number;
}

export interface DealContext {
  id: string;
  createdAt: string;
  updatedAt: string;
  mode: DealMode;
  stage: DealStage;
  stageHistory: { stage: DealStage; timestamp: string; duration: number | null }[];
  client: {
    name: string;
    contact: string;
    type: ClientType;
    budget: { min: number; max: number } | null;
    substitutionPref: SubstitutionPref | null;
    qualified: boolean;
    qualificationReason: string | null;
  };
  trip: {
    departure: string;
    arrival: string;
    date: string;
    pax: number;
    aircraftClass: AircraftClass | null;
    aircraftType: string | null;
    isRoundTrip: boolean;
    specialRequirements: string[];
  };
  guardian: {
    passes: GuardianPass[];
    currentStatus: GuardianStatus;
    blockReason: string | null;
  };
  estimate: {
    source: string;
    flightTime: number | null;
    priceRange: { low: number; high: number } | null;
    fuelBurn: number | null;
    positioning: number | null;
    calculatedAt: string | null;
  };
  sourcing: {
    selectedOperator: OperatorMatch | null;
    backupOperator: OperatorMatch | null;
    rankingReason: string;
    laneHistory: unknown[];
  };
  quote: {
    operatorPrice: number | null;
    osaPrice: number | null;
    margin: number | null;
    validUntil: string | null;
    aircraft: { type: string; tail: string; year: number } | null;
    quotedAt: string | null;
  };
  presentation: {
    sentAt: string | null;
    viewedAt: string | null;
    clientDecision: ClientDecision | null;
    decisionAt: string | null;
    timerStarted: string | null;
  };
  outcome: {
    result: string | null;
    estimateVsActual: number | null;
    operatorResponseTime: number | null;
    totalDealTime: number | null;
    revenue: number | null;
    notes: string | null;
  };
}

// ── DealRecord (mirrors deal-record.ts) ──────────────────────────────────

export interface DealRecord {
  id: string;
  timestamp: string;
  mode: DealMode;
  route: { departure: string; arrival: string; distance: number };
  aviapagesEstimate: { low: number; high: number } | null;
  operatorQuote: number | null;
  osaPrice: number | null;
  estimateDelta: number | null;
  operatorName: string | null;
  operatorBase: string | null;
  operatorResponseTime: number | null;
  operatorConversion: boolean;
  aircraftType: string | null;
  aircraftClass: string | null;
  clientName: string | null;
  clientContact: string | null;
  clientType: ClientType;
  clientBudget: { min: number; max: number } | null;
  clientConversion: boolean;
  decisionTime: number | null;
  result: string;
  revenue: number | null;
  margin: number | null;
  totalDealTime: number | null;
  dayOfWeek: number;
  season: string;
  guardianFlags: string[];
}

// ── Operator Network ─────────────────────────────────���───────────────────

export interface OperatorStats {
  name: string;
  base: string;
  totalDeals: number;
  closedDeals: number;
  conversionRate: number;
  avgResponseTime: number;
  avgDelta: number;
}

// ── Validation Ledger ───────────────────────────────────────────────────

export interface ValidationLedgerEntry {
  route: string;
  date: string;
  mode: string;
  leadTimeHours: number;
  rliAtQuote: string;
  rliScore?: number;
  dumontPhysicsEstimate: number | null;
  ghostPositioningValue: number | null;
  operatorQuotedPrice: number | null;
  osaClientPrice: number | null;
  realizedMarginPct: number | null;
  estimateDeltaPercent?: number;
  rfqsSent: number;
  quotesReceived: number;
  operatorResponseMinutes: number | null;
  clientDecisionMinutes: number | null;
  outcome: string;
  fleetResilienceUsed: boolean;
  tripCompleted: boolean | null;
  notes: string;
  // Benchmark 1: Ghost Positioning Spread
  ghostValueCents?: number;
  ghostDescription?: string;
  // Benchmark 4: Fleet Resilience
  tripOutcome?: string;
  recoveryTimeMin?: number;
  // Benchmark 5: Demand Prediction
  routePageViews7d?: number;
  // Benchmark 6: Client Decision Velocity
  optionsPresentedAt?: string;
  clientConfirmedAt?: string;
  // Benchmark 7: Network Density
  operatorsInNetwork?: number;
  operatorsInMetro?: number;
  // Operator Intelligence
  operatorName?: string;
  operatorBase?: string;
  operatorReliabilityScore?: number;
  // Outcome
  revenueCents?: number;
  // Payment State
  paymentStatus?: string;
  clientPaidAt?: string;
  operatorPaidAt?: string;
  floatWindowHours?: number;
  // Timestamps
  createdAt?: string;
  updatedAt?: string;
}

export interface LedgerSummary {
  totalDeals: number;
  bookedDeals: number;
  winRate: number;
  totalRevenue: number;
  avgMargin: number;
  avgResponseTime: number;
}

export interface DealMetrics {
  totalDeals: number;
  closedDeals: number;
  conversionRate: number;
  totalRevenue: number;
  avgDealSize: number;
  avgMargin: number;
  avgEstimateDelta: number;
}

// ── Payment & Trip Outcome ──────────────────────────────────────────────

export type PaymentStatus = "pending" | "invoiced" | "client_paid" | "operator_paid" | "margin_captured";

export type TripOutcome = "completed" | "disruption_recovered" | "disruption_failed" | "cancelled";

// ── Benchmark Metrics (GET /api/metrics/benchmarks) ─────────────────────

export interface BenchmarkMetrics {
  ghostSpread: { totalCents: number; dealCount: number; avgPerDeal: number };
  signalRatio: { ratio: number; rfqsSent: number; quotesReceived: number };
  marginByLiquidity: { high: number | null; low: number | null };
  fleetResilience: { completionRate: number; recoveriesUsed: number; avgRecoveryMin: number };
  decisionVelocity: { avgMin: number };
  networkDensity: { operators: number; perMetro: number };
  pricingAccuracy: { avgAbsDeltaPct: number; sampleSize: number };
  financial: { totalRevenueCents: number; avgMarginPct: number; totalDeals: number; bookedDeals: number; winRate: number };
}

// ── Operator Profile (mirrors composite-objects.ts OperatorProfile) ─────

export interface OperatorProfile {
  name: string;
  homeBase: string;
  certs: string[];
  fleet: string[];
  avgResponseTime: number;
  reliabilityScore: number;
  pricingDelta: number;
  paymentSpeed: number;
  quoteToBookRate: number;
  cancelRate: number;
  dealCount: number;
  lastUpdated: string;
}
