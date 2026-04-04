/**
 * Demo fixture data for the dashboard — 5 deals in various stages.
 */

import type { DealContext, DealRecord, OperatorStats } from "../types";

const now = new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

function baseCtx(id: string, mode: "sim" | "live"): DealContext {
  return {
    id, createdAt: ago(60), updatedAt: now, mode,
    stage: "intake",
    stageHistory: [{ stage: "intake", timestamp: ago(60), duration: null }],
    client: { name: "", contact: "", type: "new", budget: null, substitutionPref: null, qualified: false, qualificationReason: null },
    trip: { departure: "", arrival: "", date: "", pax: 0, aircraftClass: null, aircraftType: null, isRoundTrip: false, specialRequirements: [] },
    guardian: { passes: [], currentStatus: "clear", blockReason: null },
    estimate: { source: "aviapages", flightTime: null, priceRange: null, fuelBurn: null, positioning: null, calculatedAt: null },
    sourcing: { selectedOperator: null, backupOperator: null, rankingReason: "", laneHistory: [] },
    quote: { operatorPrice: null, osaPrice: null, margin: null, validUntil: null, aircraft: null, quotedAt: null },
    presentation: { sentAt: null, viewedAt: null, clientDecision: null, decisionAt: null, timerStarted: null },
    outcome: { result: null, estimateVsActual: null, operatorResponseTime: null, totalDealTime: null, revenue: null, notes: null },
  };
}

const op = (name: string, base: string): DealContext["sourcing"]["selectedOperator"] => ({
  operatorId: `op_${name.toLowerCase().replace(/\s/g, "_")}`,
  operatorName: name, phone: "+1-555-0100", baseAirport: base,
  aircraftType: "Phenom 300E", aircraftTail: "N300EA", score: 0.85,
  scoreBreakdown: { proximity: 0.9, laneHistory: 0.7, responseTime: 0.8, pricingAccuracy: 0.85, relationship: 0.8 },
  distanceToDeparture: 12,
});

// Deal 1: presented — waiting for client decision
const deal1: DealContext = {
  ...baseCtx("LIVE_20260331_001", "live"),
  stage: "presented",
  stageHistory: [
    { stage: "intake", timestamp: ago(45), duration: 120000 },
    { stage: "qualified", timestamp: ago(43), duration: 60000 },
    { stage: "estimated", timestamp: ago(42), duration: 180000 },
    { stage: "sourced", timestamp: ago(39), duration: 120000 },
    { stage: "quoted", timestamp: ago(37), duration: 600000 },
    { stage: "presented", timestamp: ago(27), duration: null },
  ],
  client: { name: "Sarah Chen", contact: "sarah@chen.com", type: "new", budget: { min: 25000, max: 40000 }, substitutionPref: null, qualified: true, qualificationReason: "Fully qualified" },
  trip: { departure: "KTEB", arrival: "KPBI", date: "2026-04-15", pax: 4, aircraftClass: "light", aircraftType: "Phenom 300E", isRoundTrip: false, specialRequirements: [] },
  guardian: {
    passes: [
      { stage: "intake", passed: true, checks: [
        { name: "departure_airport", passed: true, severity: "info", message: "KTEB found" },
        { name: "range", passed: true, severity: "info", message: "Route 950nm within safe range 1827nm" },
      ], timestamp: ago(44) },
      { stage: "estimated", passed: true, checks: [
        { name: "budget_overlap", passed: true, severity: "info", message: "Budget overlaps estimate" },
      ], timestamp: ago(41) },
    ],
    currentStatus: "clear", blockReason: null,
  },
  estimate: { source: "aviapages", flightTime: 150, priceRange: { low: 26000, high: 34000 }, fuelBurn: 280, positioning: null, calculatedAt: ago(42) },
  sourcing: { selectedOperator: op("Elite Aviation", "KTEB"), backupOperator: op("Jet Linx", "KMDW"), rankingReason: "Elite Aviation selected (score: 0.85)", laneHistory: [] },
  quote: { operatorPrice: 28500, osaPrice: 30978, margin: 0.08, validUntil: ahead(90), aircraft: { type: "Phenom 300E", tail: "N300EA", year: 2022 }, quotedAt: ago(30) },
  presentation: { sentAt: ago(27), viewedAt: ago(25), clientDecision: "pending", decisionAt: null, timerStarted: ago(27) },
  outcome: { result: null, estimateVsActual: null, operatorResponseTime: 1800, totalDealTime: null, revenue: null, notes: null },
};

// Deal 2: sourced — waiting for operator quote
const deal2: DealContext = {
  ...baseCtx("LIVE_20260331_002", "live"),
  stage: "sourced",
  stageHistory: [
    { stage: "intake", timestamp: ago(20), duration: 90000 },
    { stage: "qualified", timestamp: ago(18), duration: 45000 },
    { stage: "estimated", timestamp: ago(17), duration: 120000 },
    { stage: "sourced", timestamp: ago(15), duration: null },
  ],
  client: { name: "Marcus Rivera", contact: "marcus@rivera.co", type: "repeat", budget: { min: 40000, max: 65000 }, substitutionPref: "auto_within_10pct", qualified: true, qualificationReason: "Repeat client, budget confirmed" },
  trip: { departure: "KORD", arrival: "KASE", date: "2026-04-20", pax: 6, aircraftClass: "super_mid", aircraftType: null, isRoundTrip: true, specialRequirements: ["ski_gear"] },
  guardian: {
    passes: [
      { stage: "intake", passed: true, checks: [
        { name: "pax_capacity", passed: true, severity: "warning", message: "At max capacity for super_mid (9). Consider heavy." },
      ], timestamp: ago(18) },
    ],
    currentStatus: "warning", blockReason: null,
  },
  estimate: { source: "aviapages", flightTime: 195, priceRange: { low: 42000, high: 58000 }, fuelBurn: 410, positioning: null, calculatedAt: ago(17) },
  sourcing: { selectedOperator: op("Priester Aviation", "KPWK"), backupOperator: null, rankingReason: "Priester Aviation selected (score: 0.92)", laneHistory: [] },
  quote: { operatorPrice: null, osaPrice: null, margin: null, validUntil: null, aircraft: null, quotedAt: null },
  presentation: { sentAt: null, viewedAt: null, clientDecision: null, decisionAt: null, timerStarted: null },
  outcome: { result: null, estimateVsActual: null, operatorResponseTime: null, totalDealTime: null, revenue: null, notes: null },
};

// Deal 3: closed — successful SIM deal
const deal3: DealContext = {
  ...baseCtx("SIM_20260330_001", "sim"),
  stage: "closed",
  client: { name: "SIM: Northeast Run", contact: "", type: "new", budget: { min: 20000, max: 35000 }, substitutionPref: null, qualified: true, qualificationReason: "Sim scenario" },
  trip: { departure: "KTEB", arrival: "KPBI", date: "2026-03-30", pax: 3, aircraftClass: "light", aircraftType: "Citation CJ3+", isRoundTrip: false, specialRequirements: [] },
  guardian: { passes: [], currentStatus: "clear", blockReason: null },
  estimate: { source: "aviapages", flightTime: 155, priceRange: { low: 24000, high: 32000 }, fuelBurn: 250, positioning: null, calculatedAt: ago(200) },
  sourcing: { selectedOperator: op("Jet Linx", "KTEB"), backupOperator: null, rankingReason: "Closest operator", laneHistory: [] },
  quote: { operatorPrice: 26500, osaPrice: 28804, margin: 0.08, validUntil: ago(60), aircraft: { type: "Citation CJ3+", tail: "N510CJ", year: 2019 }, quotedAt: ago(180) },
  presentation: { sentAt: ago(170), viewedAt: ago(168), clientDecision: "confirmed", decisionAt: ago(150), timerStarted: ago(170) },
  outcome: { result: "closed", estimateVsActual: -0.054, operatorResponseTime: 900, totalDealTime: 3000, revenue: 2304, notes: null },
};

// Deal 4: failed — budget mismatch
const deal4: DealContext = {
  ...baseCtx("SIM_20260330_002", "sim"),
  stage: "failed",
  client: { name: "SIM: Budget Miss", contact: "", type: "new", budget: { min: 10000, max: 18000 }, substitutionPref: null, qualified: true, qualificationReason: "Sim scenario" },
  trip: { departure: "KVNY", arrival: "MMSD", date: "2026-04-01", pax: 6, aircraftClass: "heavy", aircraftType: null, isRoundTrip: true, specialRequirements: ["golf_clubs"] },
  guardian: {
    passes: [
      { stage: "estimated", passed: false, checks: [
        { name: "budget_overlap", passed: false, severity: "critical", message: "Budget $18,000 below estimate floor $55,000" },
      ], timestamp: ago(300) },
    ],
    currentStatus: "blocked", blockReason: "Budget $18,000 below estimate floor $55,000",
  },
  estimate: { source: "aviapages", flightTime: 210, priceRange: { low: 55000, high: 75000 }, fuelBurn: 520, positioning: null, calculatedAt: ago(305) },
  sourcing: { selectedOperator: null, backupOperator: null, rankingReason: "", laneHistory: [] },
  quote: { operatorPrice: null, osaPrice: null, margin: null, validUntil: null, aircraft: null, quotedAt: null },
  presentation: { sentAt: null, viewedAt: null, clientDecision: null, decisionAt: null, timerStarted: null },
  outcome: { result: "budget_mismatch", estimateVsActual: null, operatorResponseTime: null, totalDealTime: 120, revenue: null, notes: "Budget mismatch — pipeline stopped at estimate stage" },
};

// Deal 5: intake — just arrived
const deal5: DealContext = {
  ...baseCtx("LIVE_20260331_003", "live"),
  stage: "intake",
  client: { name: "James Wright", contact: "james@wright.io", type: "new", budget: null, substitutionPref: null, qualified: false, qualificationReason: null },
  trip: { departure: "KLAS", arrival: "KVNY", date: "2026-04-18", pax: 2, aircraftClass: null, aircraftType: null, isRoundTrip: false, specialRequirements: [] },
};

export const DEMO_DEALS: DealContext[] = [deal1, deal2, deal3, deal4, deal5];

export const DEMO_RECORDS: DealRecord[] = [
  {
    id: "SIM_20260330_001", timestamp: ago(150), mode: "sim",
    route: { departure: "KTEB", arrival: "KPBI", distance: 950 },
    aviapagesEstimate: { low: 24000, high: 32000 }, operatorQuote: 26500, osaPrice: 28804, estimateDelta: -0.054,
    operatorName: "Jet Linx", operatorBase: "KTEB", operatorResponseTime: 900, operatorConversion: true,
    aircraftType: "Citation CJ3+", aircraftClass: "light",
    clientName: "SIM: Northeast Run", clientContact: null, clientType: "new", clientBudget: { min: 20000, max: 35000 }, clientConversion: true, decisionTime: 1200,
    result: "closed", revenue: 2304, margin: 0.08, totalDealTime: 3000, dayOfWeek: 0, season: "peak", guardianFlags: [],
  },
  {
    id: "SIM_20260330_002", timestamp: ago(300), mode: "sim",
    route: { departure: "KVNY", arrival: "MMSD", distance: 1100 },
    aviapagesEstimate: { low: 55000, high: 75000 }, operatorQuote: null, osaPrice: null, estimateDelta: null,
    operatorName: null, operatorBase: null, operatorResponseTime: null, operatorConversion: false,
    aircraftType: null, aircraftClass: "heavy",
    clientName: "SIM: Budget Miss", clientContact: null, clientType: "new", clientBudget: { min: 10000, max: 18000 }, clientConversion: false, decisionTime: null,
    result: "budget_mismatch", revenue: null, margin: null, totalDealTime: 120, dayOfWeek: 0, season: "peak", guardianFlags: ["[critical] budget_overlap: Budget $18,000 below estimate floor $55,000"],
  },
];

export const DEMO_OPERATOR_STATS: OperatorStats[] = [
  { name: "Elite Aviation", base: "KTEB", totalDeals: 12, closedDeals: 10, conversionRate: 0.83, avgResponseTime: 1800, avgDelta: 0.04 },
  { name: "Jet Linx", base: "KTEB", totalDeals: 8, closedDeals: 7, conversionRate: 0.88, avgResponseTime: 1200, avgDelta: -0.02 },
  { name: "Priester Aviation", base: "KPWK", totalDeals: 5, closedDeals: 4, conversionRate: 0.80, avgResponseTime: 2400, avgDelta: 0.08 },
];
