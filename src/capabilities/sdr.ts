/**
 * SDR Qualification — classifies inbound leads.
 * Per spec: communication-layer.md FR-6.
 * Uses existing intake.ts extractors — no duplicate parsing logic.
 */

import type { DealContext } from "../schemas/deal-context.js";
import { extractPax, extractBudget, extractRoute, extractDate } from "./intake.js";

// ── Types ────────────────────────────────────────────────────────────────

export type SDRClassification =
  | "qualified_with_budget"
  | "qualified_no_budget"
  | "not_qualified"
  | "budget_mismatch";

export interface SDRResult {
  classification: SDRClassification;
  confidence: number;
  shouldAutoRespond: boolean;
  escalateToHuman: boolean;
  reason: string;
  extractedFields: string[];
}

// ── Main function ────────────────────────────────────────────────────────

/**
 * Classify an inbound message for SDR qualification.
 * Uses the same extractors as intake.ts to pull structured data from text.
 *
 * @param body - The inbound message text.
 * @param deal - The deal context (if estimate is available for budget check).
 * @param today - Today's date for relative date parsing.
 * @returns SDR result with classification, confidence, and response guidance.
 */
export function classifyLead(
  body: string,
  deal?: DealContext | null,
  today?: Date,
): SDRResult {
  const extractedFields: string[] = [];

  const [dep, arr] = extractRoute(body);
  if (dep) extractedFields.push("departure");
  if (arr) extractedFields.push("arrival");

  const date = extractDate(body, today);
  if (date) extractedFields.push("date");

  const pax = extractPax(body);
  if (pax && pax > 0) extractedFields.push("pax");

  const budget = extractBudget(body);
  if (budget) extractedFields.push("budget");

  const hasRoute = dep !== null || arr !== null;
  const hasDate = date !== null;
  const hasPax = pax !== null && pax > 0;
  const hasBudget = budget !== null;

  // Not qualified — missing critical fields
  if (!hasRoute || !hasDate || !hasPax) {
    const missing: string[] = [];
    if (!hasRoute) missing.push("route");
    if (!hasDate) missing.push("date");
    if (!hasPax) missing.push("passengers");
    return {
      classification: "not_qualified",
      confidence: 0.9,
      shouldAutoRespond: true,
      escalateToHuman: false,
      reason: `Missing: ${missing.join(", ")}. Ask client for details.`,
      extractedFields,
    };
  }

  // Budget mismatch — budget below estimate floor
  if (hasBudget && deal?.estimate.priceRange) {
    if (budget.max < deal.estimate.priceRange.low) {
      return {
        classification: "budget_mismatch",
        confidence: 0.85,
        shouldAutoRespond: true,
        escalateToHuman: false,
        reason: `Budget $${budget.max.toLocaleString()} below estimate floor $${deal.estimate.priceRange.low.toLocaleString()}.`,
        extractedFields,
      };
    }
  }

  // Qualified with budget
  if (hasBudget) {
    return {
      classification: "qualified_with_budget",
      confidence: 0.95,
      shouldAutoRespond: false,
      escalateToHuman: false,
      reason: "Fully qualified. Route, date, passengers, and budget confirmed.",
      extractedFields,
    };
  }

  // Qualified without budget
  return {
    classification: "qualified_no_budget",
    confidence: 0.9,
    shouldAutoRespond: true,
    escalateToHuman: false,
    reason: "Qualified but no budget. Send budget inquiry.",
    extractedFields,
  };
}
