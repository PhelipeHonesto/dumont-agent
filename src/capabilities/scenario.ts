/**
 * Scenario Capability — generate client-facing quote presentation and manage
 * backup activation logic.
 *
 * Per spec: capabilities/scenario.md
 *
 * Responsibilities:
 * 1. Build a QuotePresentation object from DealContext (route, aircraft, price,
 *    safety verification, validity window)
 * 2. Pre-rank backup from sourcing.backupOperator — never present unless needed
 * 3. Substitution logic when primary falls through:
 *    - auto_within_10pct: auto-present backup if price within 10%
 *    - always_approve: pause for client approval
 *    - cancel_if_unavailable: close deal as failed
 * 4. Timer alert thresholds at 70% and 90% of validity window
 *
 * The orchestrator writes sentAt/timerStarted/clientDecision into
 * DealContext.presentation. This capability returns that shape.
 */

import type { DealContext, SubstitutionPref } from "../schemas/deal-context.js";
import type { ScenarioResult } from "../orchestrator/index.js";
import { QUOTE_VALIDITY } from "../config.js";
import { ScenarioError } from "../utils/errors.js";

// ── Quote Presentation (client-facing content) ───────────────────────────

export interface QuotePresentation {
  /** Route summary. */
  route: {
    departure: string;    // ICAO
    arrival: string;      // ICAO
    date: string;         // ISO date
    isRoundTrip: boolean;
  };
  /** Aircraft details. */
  aircraft: {
    type: string;
    tail: string | null;
    year: number | null;
    operatorName: string;
  } | null;
  /** All-in price — no hidden fees. */
  pricing: {
    totalAllIn: number;           // OSA price (includes margin)
    includes: string[];            // what's covered
    validUntil: string;            // ISO datetime
    validityMinutes: number;
  };
  /** Safety verification from Guardian. */
  safety: {
    operatorName: string;
    guardianVerified: boolean;
    guardianStatus: string;        // "clear" | "warning"
  };
  /** Passenger info. */
  passengers: number;
  /** Special requirements confirmed. */
  specialRequirements: string[];
}

/**
 * Build the client-facing presentation from deal context.
 * Returns null if required data is missing (operator, quote, trip).
 */
export function buildPresentation(ctx: DealContext): QuotePresentation | null {
  const { trip, quote, sourcing, guardian } = ctx;

  // Reject if critical data is missing
  if (!sourcing.selectedOperator) return null;
  if (!quote.osaPrice) return null;
  if (!quote.validUntil) return null;
  if (!trip.departure || !trip.arrival) return null;

  const validUntilMs = new Date(quote.validUntil).getTime();
  const nowMs = Date.now();
  const validityMinutes = Math.max(0, Math.round((validUntilMs - nowMs) / 60_000));

  return {
    route: {
      departure: trip.departure,
      arrival: trip.arrival,
      date: trip.date,
      isRoundTrip: trip.isRoundTrip,
    },
    aircraft: quote.aircraft
      ? {
          type: quote.aircraft.type,
          tail: quote.aircraft.tail,
          year: quote.aircraft.year,
          operatorName: sourcing.selectedOperator.operatorName,
        }
      : {
          type: sourcing.selectedOperator.aircraftType,
          tail: sourcing.selectedOperator.aircraftTail,
          year: null,
          operatorName: sourcing.selectedOperator.operatorName,
        },
    pricing: {
      totalAllIn: quote.osaPrice,
      includes: ["crew", "fuel", "landing fees", "FBO handling", "taxes"],
      validUntil: quote.validUntil,
      validityMinutes,
    },
    safety: {
      operatorName: sourcing.selectedOperator.operatorName,
      guardianVerified: guardian.currentStatus !== "blocked",
      guardianStatus: guardian.currentStatus,
    },
    passengers: trip.pax,
    specialRequirements: trip.specialRequirements,
  };
}

// ── Timer Alerts ─────────────────────────────────────────────────────────

export type TimerAlertLevel = "none" | "amber" | "red" | "expired";

export interface TimerStatus {
  level: TimerAlertLevel;
  elapsedPercent: number;
  remainingMinutes: number;
}

/**
 * Check the timer status relative to the validity window.
 * - <70%: "none"
 * - 70-89%: "amber" — alert Phelipe via Mission Control
 * - 90-99%: "red" — urgent + prepare backup activation
 * - ≥100%: "expired" — follow substitution logic
 */
export function checkTimer(
  timerStarted: string,
  validUntil: string,
  now: Date = new Date(),
): TimerStatus {
  const startMs = new Date(timerStarted).getTime();
  const endMs = new Date(validUntil).getTime();
  const nowMs = now.getTime();

  const totalMs = endMs - startMs;
  if (totalMs <= 0) {
    return { level: "expired", elapsedPercent: 1, remainingMinutes: 0 };
  }

  const elapsedMs = nowMs - startMs;
  const elapsedPercent = elapsedMs / totalMs;
  const remainingMs = Math.max(0, endMs - nowMs);
  const remainingMinutes = Math.round(remainingMs / 60_000);

  if (elapsedPercent >= 1) {
    return { level: "expired", elapsedPercent: 1, remainingMinutes: 0 };
  }
  if (elapsedPercent >= QUOTE_VALIDITY.urgentAtPercent) {
    return { level: "red", elapsedPercent, remainingMinutes };
  }
  if (elapsedPercent >= QUOTE_VALIDITY.alertAtPercent) {
    return { level: "amber", elapsedPercent, remainingMinutes };
  }
  return { level: "none", elapsedPercent, remainingMinutes };
}

// ── Backup Activation Logic ──────────────────────────────────────────────

export type BackupAction =
  | { action: "auto_present"; reason: string }
  | { action: "pause_for_approval"; reason: string }
  | { action: "cancel_deal"; reason: string }
  | { action: "no_backup"; reason: string };

/**
 * Determine what to do when the primary falls through.
 *
 * Checks client.substitutionPref:
 * - auto_within_10pct: auto-present backup if backup price within 10% of primary
 * - always_approve: pause pipeline, call client for approval
 * - cancel_if_unavailable: close deal as failed
 * - null (new client): default to pause_for_approval
 */
export function determineBackupAction(
  ctx: DealContext,
  backupOsaPrice: number | null,
): BackupAction {
  const { sourcing, client, quote } = ctx;

  if (!sourcing.backupOperator) {
    return { action: "no_backup", reason: "No backup operator was ranked" };
  }

  if (backupOsaPrice === null) {
    return { action: "pause_for_approval", reason: "Backup operator available but no price yet — call for quote" };
  }

  const pref: SubstitutionPref | null = client.substitutionPref;
  const primaryPrice = quote.osaPrice;

  switch (pref) {
    case "auto_within_10pct": {
      if (primaryPrice && backupOsaPrice <= primaryPrice * 1.10) {
        return {
          action: "auto_present",
          reason: `Backup price $${backupOsaPrice.toLocaleString()} within 10% of primary $${primaryPrice.toLocaleString()}. Auto-presenting.`,
        };
      }
      return {
        action: "pause_for_approval",
        reason: `Backup price $${backupOsaPrice.toLocaleString()} exceeds 10% threshold of primary $${primaryPrice?.toLocaleString() ?? "unknown"}. Needs client approval.`,
      };
    }

    case "always_approve":
      return {
        action: "pause_for_approval",
        reason: `Client preference: always approve substitutions. Presenting backup $${backupOsaPrice.toLocaleString()} for approval.`,
      };

    case "cancel_if_unavailable":
      return {
        action: "cancel_deal",
        reason: "Client preference: cancel if primary unavailable",
      };

    default:
      // No preference (new client) → default to human approval
      return {
        action: "pause_for_approval",
        reason: `New client, no substitution preference. Call client to present backup at $${backupOsaPrice.toLocaleString()}.`,
      };
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────

/**
 * Generate the scenario / presentation for the current deal.
 *
 * Returns the DealContext["presentation"] shape. The orchestrator writes
 * sentAt, timerStarted, and clientDecision into the context after calling this.
 */
export async function scenario(ctx: DealContext): Promise<ScenarioResult> {
  // Build the presentation — validates that all required data exists
  const presentation = buildPresentation(ctx);

  if (!presentation) {
    const missing = [
      !ctx.sourcing.selectedOperator && "no operator selected",
      !ctx.quote.osaPrice && "no OSA price",
      !ctx.quote.validUntil && "no validity window",
      !ctx.trip.departure && "no departure",
      !ctx.trip.arrival && "no arrival",
    ].filter(Boolean).join(", ");
    throw new ScenarioError(`Missing data for quote presentation: ${missing}`);
  }

  // Return the presentation tracking fields — content is in the presentation object
  return {
    presentation: {
      sentAt: null,           // orchestrator fills on send
      viewedAt: null,
      clientDecision: null,   // orchestrator sets to "pending"
      decisionAt: null,
      timerStarted: null,     // orchestrator fills on send
    },
  };
}

// Re-export ScenarioError from shared errors module
export { ScenarioError } from "../utils/errors.js";
