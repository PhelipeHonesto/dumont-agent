/**
 * Guardian Capability — continuous validation at every pipeline stage.
 * Runs stage-specific checks. Protects client, operator, and OSA.
 *
 * Per spec: capabilities/guardian.md
 *
 * CRITICAL: Guardian NEVER auto-corrects. It flags. Humans decide.
 * CRITICAL: Guardian NEVER returns "passed" if any check is critical + failed.
 *
 * Bugs fixed from old simulator (~/osa/simulator/src/agents/guardian.ts):
 * - checkRange (line 224): was a no-op that always returned pass. Now uses
 *   haversine to compute actual distance and compare against aircraft range
 *   with 10% safety margin.
 * - Warning double-count (line 361): determineVerdict counted warnings from
 *   both score.warning AND flags — but flags are generated from the same
 *   checklist warnings. Now uses only the checks array directly.
 */

import type { DealContext, GuardianCheck, GuardianPass } from "../schemas/deal-context.js";
import type { GuardianResult } from "../orchestrator/index.js";
import { haversine } from "../utils/haversine.js";
import { MARGIN_POLICY, ESTIMATE_TOLERANCE, GUARDIAN_THRESHOLDS } from "../config.js";

// ── Reference Data ───────────────────────────────────────────────────────
// Embedded from ~/osa/simulator/src/fixtures/aircraft-performance.json
// and ~/osa/simulator/src/fixtures/airports.json.
// In production these come from Aviapages API / operator CRM.

export interface AircraftPerf {
  type: string;
  category: string;
  range_nm: number;
  runway_required_ft: number;
  passenger_capacity: number;
}

export interface AirportData {
  icao: string;
  latitude: number;
  longitude: number;
  longest_runway_ft: number;
  customs_capable: boolean;
}

/** Known aircraft performance data — source of truth for Guardian checks. */
export const AIRCRAFT_PERF: Record<string, AircraftPerf> = {
  "Citation CJ3+":       { type: "Citation CJ3+",       category: "light",            range_nm: 2040, runway_required_ft: 3180, passenger_capacity: 7 },
  "Phenom 300E":         { type: "Phenom 300E",         category: "light",            range_nm: 2010, runway_required_ft: 3209, passenger_capacity: 8 },
  "Learjet 75 Liberty":  { type: "Learjet 75 Liberty",  category: "light",            range_nm: 2040, runway_required_ft: 4250, passenger_capacity: 7 },
  "King Air 350i":       { type: "King Air 350i",       category: "light",            range_nm: 1806, runway_required_ft: 3300, passenger_capacity: 9 },
  "Citation Latitude":   { type: "Citation Latitude",   category: "midsize",          range_nm: 2700, runway_required_ft: 3580, passenger_capacity: 9 },
  "Gulfstream G280":     { type: "Gulfstream G280",     category: "super_mid",        range_nm: 3600, runway_required_ft: 4750, passenger_capacity: 10 },
  "Challenger 300":      { type: "Challenger 300",      category: "super_mid",        range_nm: 3100, runway_required_ft: 4810, passenger_capacity: 9 },
  "Citation X+":         { type: "Citation X+",         category: "super_mid",        range_nm: 3070, runway_required_ft: 5250, passenger_capacity: 8 },
  "Gulfstream G550":     { type: "Gulfstream G550",     category: "heavy",            range_nm: 6750, runway_required_ft: 5910, passenger_capacity: 14 },
  "Global 7500":         { type: "Global 7500",         category: "ultra_long_range", range_nm: 7700, runway_required_ft: 5800, passenger_capacity: 17 },
};

/** Default performance by aircraft class — fallback when specific type unknown. */
const CLASS_DEFAULTS: Record<string, AircraftPerf> = {
  light:            { type: "light (default)",            category: "light",            range_nm: 1800, runway_required_ft: 3500, passenger_capacity: 7 },
  midsize:          { type: "midsize (default)",          category: "midsize",          range_nm: 2700, runway_required_ft: 4000, passenger_capacity: 9 },
  super_mid:        { type: "super_mid (default)",        category: "super_mid",        range_nm: 3200, runway_required_ft: 5000, passenger_capacity: 9 },
  heavy:            { type: "heavy (default)",            category: "heavy",            range_nm: 6000, runway_required_ft: 5500, passenger_capacity: 14 },
  ultra_long_range: { type: "ultra_long_range (default)", category: "ultra_long_range", range_nm: 7500, runway_required_ft: 5800, passenger_capacity: 17 },
};

const SAFETY_MARGINS = GUARDIAN_THRESHOLDS.safetyMargins;

// ── Lookup Helpers ───────────────────────────────────────────────────────

/**
 * Resolve aircraft performance from type string or aircraft class.
 * Tries exact match first, then class default.
 */
export function resolveAircraftPerf(
  aircraftType: string | null,
  aircraftClass: string | null,
): AircraftPerf | null {
  if (aircraftType && AIRCRAFT_PERF[aircraftType]) {
    return AIRCRAFT_PERF[aircraftType]!;
  }
  if (aircraftClass && CLASS_DEFAULTS[aircraftClass]) {
    return CLASS_DEFAULTS[aircraftClass]!;
  }
  return null;
}

// ── Check Constructors ───────────────────────────────────────────────────

function passCheck(name: string, message: string): GuardianCheck {
  return { name, passed: true, severity: "info", message };
}

function warnCheck(name: string, message: string): GuardianCheck {
  return { name, passed: true, severity: "warning", message };
}

function criticalFail(name: string, message: string): GuardianCheck {
  return { name, passed: false, severity: "critical", message };
}

// ── Stage-Specific Checks ────────────────────────────────────────────────

/**
 * After INTAKE: is the trip physically possible?
 * - Departure airport exists
 * - Arrival airport exists
 * - Runway sufficient at both airports
 * - Range feasible (haversine + safety margin)
 * - Pax within aircraft class capacity
 * - Date in the future
 */
export function checksAfterIntake(
  ctx: DealContext,
  airports: Map<string, AirportData>,
): GuardianCheck[] {
  const checks: GuardianCheck[] = [];
  const { trip } = ctx;

  // Departure airport
  const dep = airports.get(trip.departure);
  if (!trip.departure) {
    checks.push(criticalFail("departure_airport", "No departure airport specified"));
  } else if (!dep) {
    checks.push(warnCheck("departure_airport", `Departure ${trip.departure} not in airport database. Cannot validate runway or range.`));
  } else {
    checks.push(passCheck("departure_airport", `Departure ${trip.departure} found`));
  }

  // Arrival airport
  const arr = airports.get(trip.arrival);
  if (!trip.arrival) {
    checks.push(criticalFail("arrival_airport", "No arrival airport specified"));
  } else if (!arr) {
    checks.push(warnCheck("arrival_airport", `Arrival ${trip.arrival} not in airport database. Cannot validate runway or range.`));
  } else {
    checks.push(passCheck("arrival_airport", `Arrival ${trip.arrival} found`));
  }

  // Resolve aircraft performance
  const perf = resolveAircraftPerf(trip.aircraftType, trip.aircraftClass);

  // Runway checks (only if we have both airport and aircraft data)
  if (perf) {
    const requiredFt = Math.ceil(perf.runway_required_ft * SAFETY_MARGINS.runway);

    if (dep) {
      if (dep.longest_runway_ft < requiredFt) {
        checks.push(criticalFail(
          "runway_departure",
          `${trip.departure} runway ${dep.longest_runway_ft}ft too short. ${perf.type} needs ${requiredFt}ft (${perf.runway_required_ft}ft + 10% margin).`,
        ));
      } else {
        checks.push(passCheck(
          "runway_departure",
          `${trip.departure} runway ${dep.longest_runway_ft}ft adequate for ${perf.type} (needs ${requiredFt}ft)`,
        ));
      }
    }

    if (arr) {
      if (arr.longest_runway_ft < requiredFt) {
        checks.push(criticalFail(
          "runway_arrival",
          `${trip.arrival} runway ${arr.longest_runway_ft}ft too short. ${perf.type} needs ${requiredFt}ft (${perf.runway_required_ft}ft + 10% margin).`,
        ));
      } else {
        checks.push(passCheck(
          "runway_arrival",
          `${trip.arrival} runway ${arr.longest_runway_ft}ft adequate for ${perf.type} (needs ${requiredFt}ft)`,
        ));
      }
    }

    // Range check — FIX for old bug at line 224.
    // Old implementation was a no-op that always returned pass.
    // Now: compute haversine distance, compare with aircraft range minus 10% safety margin.
    if (dep && arr) {
      const distanceNm = haversine(dep.latitude, dep.longitude, arr.latitude, arr.longitude);
      const safeRange = perf.range_nm / SAFETY_MARGINS.range; // usable range after IFR reserve

      if (distanceNm > safeRange) {
        checks.push(criticalFail(
          "range",
          `Route distance ${Math.round(distanceNm)}nm exceeds ${perf.type} safe range ${Math.round(safeRange)}nm (max ${perf.range_nm}nm minus 10% IFR reserve)`,
        ));
      } else {
        const margin = ((safeRange - distanceNm) / safeRange * 100).toFixed(0);
        checks.push(passCheck(
          "range",
          `Route distance ${Math.round(distanceNm)}nm within ${perf.type} safe range ${Math.round(safeRange)}nm (${margin}% margin)`,
        ));
      }
    }

    // Pax capacity
    if (trip.pax > 0) {
      if (trip.pax > perf.passenger_capacity) {
        checks.push(criticalFail(
          "pax_capacity",
          `${trip.pax} passengers exceeds ${perf.type} capacity of ${perf.passenger_capacity}`,
        ));
      } else if (trip.pax === perf.passenger_capacity) {
        checks.push(warnCheck(
          "pax_capacity",
          `At max capacity (${trip.pax}/${perf.passenger_capacity}). No room for additional passengers.`,
        ));
      } else {
        checks.push(passCheck(
          "pax_capacity",
          `${trip.pax} passengers, ${perf.type} capacity ${perf.passenger_capacity}. ${perf.passenger_capacity - trip.pax} seats margin.`,
        ));
      }
    }
  } else if (trip.aircraftType || trip.aircraftClass) {
    checks.push(warnCheck("aircraft_data", `Unknown aircraft "${trip.aircraftType ?? trip.aircraftClass}". Cannot validate runway, range, or capacity.`));
  }

  // Date in the future
  if (trip.date) {
    const tripDate = new Date(trip.date);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    if (tripDate < now) {
      checks.push(criticalFail("date_future", `Trip date ${trip.date} is in the past`));
    } else {
      checks.push(passCheck("date_future", `Trip date ${trip.date} is valid`));
    }
  } else {
    checks.push(criticalFail("date_future", "No trip date specified"));
  }

  return checks;
}

/**
 * After ESTIMATE: does client budget overlap the price range?
 */
export function checksAfterEstimate(ctx: DealContext): GuardianCheck[] {
  const checks: GuardianCheck[] = [];
  const { client, estimate } = ctx;

  if (!estimate.priceRange) {
    checks.push(warnCheck("estimate_available", "No price estimate available. Cannot validate budget overlap."));
    return checks;
  }

  checks.push(passCheck("estimate_available", `Estimate range $${estimate.priceRange.low.toLocaleString()}-$${estimate.priceRange.high.toLocaleString()}`));

  // Suspiciously low estimate (possible API error)
  if (estimate.priceRange.low < GUARDIAN_THRESHOLDS.estimateSanityFloor) {
    checks.push(warnCheck("estimate_sanity", `Estimate floor $${estimate.priceRange.low} unusually low. Possible API error.`));
  }

  if (!client.budget) {
    checks.push(warnCheck("budget_overlap", "Client budget not set. Cannot check overlap."));
    return checks;
  }

  // Budget must overlap estimate range
  // Client max below estimate low = budget mismatch
  if (client.budget.max < estimate.priceRange.low) {
    checks.push(criticalFail(
      "budget_overlap",
      `Client budget ceiling $${client.budget.max.toLocaleString()} is below estimate floor $${estimate.priceRange.low.toLocaleString()}`,
    ));
  } else if (client.budget.min > estimate.priceRange.high) {
    // Client min above estimate high — unusual but not blocking
    checks.push(warnCheck(
      "budget_overlap",
      `Client minimum $${client.budget.min.toLocaleString()} above estimate ceiling $${estimate.priceRange.high.toLocaleString()}. Client expects premium options.`,
    ));
  } else {
    checks.push(passCheck(
      "budget_overlap",
      `Client budget $${client.budget.min.toLocaleString()}-$${client.budget.max.toLocaleString()} overlaps estimate $${estimate.priceRange.low.toLocaleString()}-$${estimate.priceRange.high.toLocaleString()}`,
    ));
  }

  return checks;
}

/**
 * After SOURCING: is the selected operator safe and certified?
 */
export function checksAfterSourcing(
  ctx: DealContext,
  operatorCerts?: Map<string, OperatorCertData>,
): GuardianCheck[] {
  const checks: GuardianCheck[] = [];
  const { sourcing } = ctx;

  if (!sourcing.selectedOperator) {
    checks.push(criticalFail("operator_selected", "No operator selected"));
    return checks;
  }

  const op = sourcing.selectedOperator;
  checks.push(passCheck("operator_selected", `Selected operator: ${op.operatorName} (${op.baseAirport})`));

  // Check certifications if data available
  const cert = operatorCerts?.get(op.operatorId);
  if (cert) {
    // Active AOC / Part 135
    if (cert.part135Active) {
      checks.push(passCheck("part135_cert", `${op.operatorName} Part 135 certificate active`));
    } else {
      checks.push(criticalFail("part135_cert", `${op.operatorName} Part 135 certificate NOT active`));
    }

    // Insurance current
    if (cert.insuranceCurrent) {
      checks.push(passCheck("insurance", `${op.operatorName} insurance confirmed current`));
    } else if (cert.insuranceCurrent === false) {
      checks.push(criticalFail("insurance", `${op.operatorName} insurance expired or not confirmed`));
    } else {
      checks.push(warnCheck("insurance", `${op.operatorName} insurance status unverified`));
    }

    // Safety rating
    if (cert.argusRating === "platinum" || cert.argusRating === "gold") {
      checks.push(passCheck("safety_rating", `${op.operatorName} ARGUS ${cert.argusRating}`));
    } else if (cert.wyvernRating === "wingman" || cert.wyvernRating === "approved") {
      checks.push(passCheck("safety_rating", `${op.operatorName} Wyvern ${cert.wyvernRating}`));
    } else if (cert.argusRating === "silver") {
      checks.push(warnCheck("safety_rating", `${op.operatorName} ARGUS Silver. Below preferred minimum.`));
    } else {
      checks.push(warnCheck("safety_rating", `${op.operatorName} no recognized safety rating (ARGUS/Wyvern)`));
    }
  } else {
    // No cert data — flag as warning, don't block (day 1-10 cold start)
    checks.push(warnCheck("part135_cert", `Certification data not available for ${op.operatorName}. Verify manually.`));
    checks.push(warnCheck("insurance", `Insurance data not available for ${op.operatorName}. Verify manually.`));
  }

  // Aircraft type match
  if (ctx.trip.aircraftType && op.aircraftType !== ctx.trip.aircraftType) {
    checks.push(warnCheck(
      "aircraft_match",
      `Client requested ${ctx.trip.aircraftType}, operator offering ${op.aircraftType}`,
    ));
  }

  return checks;
}

/**
 * After QUOTE: is the operator quote within reasonable range of estimate?
 */
export function checksAfterQuote(ctx: DealContext): GuardianCheck[] {
  const checks: GuardianCheck[] = [];
  const { quote, estimate } = ctx;

  if (!quote.operatorPrice) {
    checks.push(warnCheck("quote_available", "No operator quote entered yet"));
    return checks;
  }

  checks.push(passCheck("quote_available", `Operator quote: $${quote.operatorPrice.toLocaleString()}`));

  // Quote vs estimate sanity (25% tolerance per spec)
  if (estimate.priceRange) {
    const estimateMedian = (estimate.priceRange.low + estimate.priceRange.high) / 2;
    const delta = Math.abs(quote.operatorPrice - estimateMedian) / estimateMedian;

    if (delta > ESTIMATE_TOLERANCE.warningThreshold) {
      checks.push(warnCheck(
        "quote_vs_estimate",
        `Operator quote $${quote.operatorPrice.toLocaleString()} is ${(delta * 100).toFixed(0)}% off estimate median $${Math.round(estimateMedian).toLocaleString()} (threshold: ${ESTIMATE_TOLERANCE.warningThreshold * 100}%)`,
      ));
    } else {
      checks.push(passCheck(
        "quote_vs_estimate",
        `Operator quote within ${(delta * 100).toFixed(0)}% of estimate median (threshold: ${ESTIMATE_TOLERANCE.warningThreshold * 100}%)`,
      ));
    }
  }

  // Margin check (8-15% per spec, >50% is critical — pipeline halt)
  if (quote.margin !== null) {
    if (quote.margin > 0.50) {
      checks.push(criticalFail(
        "margin_policy",
        `Margin ${(quote.margin * 100).toFixed(1)}% exceeds 50% hard limit — pipeline halted`,
      ));
    } else if (quote.margin < MARGIN_POLICY.min) {
      checks.push(warnCheck(
        "margin_policy",
        `Margin ${(quote.margin * 100).toFixed(1)}% below minimum ${MARGIN_POLICY.min * 100}%`,
      ));
    } else if (quote.margin > MARGIN_POLICY.max) {
      checks.push(warnCheck(
        "margin_policy",
        `Margin ${(quote.margin * 100).toFixed(1)}% above maximum ${MARGIN_POLICY.max * 100}%`,
      ));
    } else {
      checks.push(passCheck(
        "margin_policy",
        `Margin ${(quote.margin * 100).toFixed(1)}% within policy (${MARGIN_POLICY.min * 100}-${MARGIN_POLICY.max * 100}%)`,
      ));
    }
  }

  // Quote validity window
  if (quote.validUntil) {
    const validMs = new Date(quote.validUntil).getTime() - Date.now();
    const validMin = Math.round(validMs / 60_000);
    if (validMin < GUARDIAN_THRESHOLDS.quoteValidityMinMinutes) {
      checks.push(warnCheck("quote_validity", `Quote validity only ${validMin} minutes. Under ${GUARDIAN_THRESHOLDS.quoteValidityMinMinutes}-minute minimum.`));
    } else {
      checks.push(passCheck("quote_validity", `Quote valid for ${validMin} minutes`));
    }
  }

  return checks;
}

/**
 * Before PRESENTATION: final sanity — everything still valid.
 */
export function checksBeforePresentation(ctx: DealContext): GuardianCheck[] {
  const checks: GuardianCheck[] = [];

  // All required data populated
  if (!ctx.sourcing.selectedOperator) {
    checks.push(criticalFail("pre_present_operator", "No operator selected. Cannot present quote."));
  }
  if (!ctx.quote.osaPrice) {
    checks.push(criticalFail("pre_present_price", "No OSA price calculated. Cannot present quote."));
  }
  if (!ctx.quote.operatorPrice) {
    checks.push(criticalFail("pre_present_quote", "No operator quote. Cannot present to client."));
  }

  // Everything present
  if (ctx.sourcing.selectedOperator && ctx.quote.osaPrice && ctx.quote.operatorPrice) {
    checks.push(passCheck("pre_present_complete", "All required deal data present for presentation"));
  }

  return checks;
}

// ── Operator Certification Data ──────────────────────────────────────────

export interface OperatorCertData {
  operatorId: string;
  part135Active: boolean;
  insuranceCurrent: boolean | null;
  argusRating: "platinum" | "gold" | "silver" | "registered" | null;
  wyvernRating: "wingman" | "approved" | null;
}

// ── Main Guardian Entry Point ────────────────────────────────────────────

export interface GuardianOptions {
  airports?: Map<string, AirportData>;
  operatorCerts?: Map<string, OperatorCertData>;
}

export async function guardian(
  stage: string,
  ctx: DealContext,
  options: GuardianOptions = {},
): Promise<GuardianResult> {
  const { airports = new Map(), operatorCerts } = options;

  let checks: GuardianCheck[];

  switch (stage) {
    case "intake":
      checks = checksAfterIntake(ctx, airports);
      break;
    case "estimated":
      checks = checksAfterEstimate(ctx);
      break;
    case "sourced":
      checks = checksAfterSourcing(ctx, operatorCerts);
      break;
    case "quoted":
      checks = checksAfterQuote(ctx);
      break;
    case "presented":
      checks = checksBeforePresentation(ctx);
      break;
    default:
      checks = [passCheck("unknown_stage", `No specific checks for stage: ${stage}`)];
  }

  // Determine pass/fail — FIX for old warning double-count bug (line 361).
  // Old code counted score.warning + flags.filter(warning) which double-counted
  // because flags were generated from the same warnings. Now we use a single
  // source: the checks array itself.
  const hasCriticalFailure = checks.some((c) => !c.passed && c.severity === "critical");
  const passed = !hasCriticalFailure;

  const pass: GuardianPass = {
    stage,
    passed,
    checks,
    timestamp: new Date().toISOString(),
  };

  return { pass };
}
