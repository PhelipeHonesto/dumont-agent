/**
 * Draft Evaluator — evaluator-optimizer pattern for outbound messages.
 * Per spec: communication-layer.md FR-9, section 2.5.
 * Source: Anthropic "Building Effective Agents" — evaluator-optimizer workflow.
 *
 * Flow: Haiku evaluates → if issues → Sonnet revises → return result.
 */

import type { Message } from "../schemas/message.js";
import type { DealContext } from "../schemas/deal-context.js";
import type { EditPattern } from "../memory/edit-memory.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface EvaluationResult {
  draft: string;
  wasRevised: boolean;
  issues: string[];
  originalBeforeRevision: string | null;
}

/** Injectable evaluator function (LLM call). Defaults to pass-through in tests. */
export type EvaluatorFn = (draft: string, context: EvaluatorContext) => Promise<{ issues: string[]; pass: boolean }>;

/** Injectable reviser function (LLM call). */
export type ReviserFn = (original: string, issues: string[], context: EvaluatorContext) => Promise<string>;

export interface EvaluatorContext {
  dealSummary: string;
  clientType: string;
  recipientType: string;
  editExamples: EditPattern[];
}

// ── Evaluation ───────────────────────────────────────────────────────────

/**
 * Summarize a deal context for the evaluator (keeps token budget small).
 */
export function summarizeDealForEval(deal: DealContext): string {
  const parts: string[] = [];
  parts.push(`Route: ${deal.trip.departure} → ${deal.trip.arrival}`);
  parts.push(`Date: ${deal.trip.date}`);
  parts.push(`Pax: ${deal.trip.pax}`);
  if (deal.trip.aircraftClass) parts.push(`Aircraft class: ${deal.trip.aircraftClass}`);
  if (deal.estimate.priceRange) {
    parts.push(`Estimate: $${deal.estimate.priceRange.low.toLocaleString()}-$${deal.estimate.priceRange.high.toLocaleString()}`);
  }
  if (deal.quote.osaPrice) parts.push(`OSA price: $${deal.quote.osaPrice.toLocaleString()}`);
  if (deal.sourcing.selectedOperator) parts.push(`Operator: ${deal.sourcing.selectedOperator.operatorName}`);
  return parts.join(". ");
}

/**
 * Get the recipient type from the message and deal context.
 */
function getRecipientType(draft: Message, deal: DealContext): string {
  const to = draft.to?.toLowerCase() ?? "";
  const clientContact = deal.client.contact?.toLowerCase() ?? "";
  if (clientContact && to.includes(clientContact)) return "client";
  return "operator";
}

export interface EvaluateDraftOptions {
  /** Injectable evaluator (Haiku). Uses code-based checks if not provided. */
  evaluator?: EvaluatorFn;
  /** Injectable reviser (Sonnet). Required if evaluator is provided. */
  reviser?: ReviserFn;
  /** Edit history for broker style context. */
  editHistory?: EditPattern[];
}

/**
 * Evaluate a draft message and optionally revise it.
 * Two-pass: Haiku evaluates, Sonnet revises if issues found.
 *
 * @param draft - The outbound message draft to evaluate.
 * @param deal - Current deal context for accuracy checks.
 * @param options - Injectable LLM functions and edit history.
 * @returns Evaluation result with original/revised draft and issues.
 */
export async function evaluateDraft(
  draft: Message,
  deal: DealContext,
  options: EvaluateDraftOptions = {},
): Promise<EvaluationResult> {
  const context: EvaluatorContext = {
    dealSummary: summarizeDealForEval(deal),
    clientType: deal.client.type,
    recipientType: getRecipientType(draft, deal),
    editExamples: options.editHistory ?? [],
  };

  // ── Code-based checks (always run, no LLM needed) ─────────────────

  const codeIssues = runCodeChecks(draft, deal);

  // ── LLM evaluation (if evaluator provided) ─────────────────────────

  let llmIssues: string[] = [];
  if (options.evaluator) {
    const evaluation = await options.evaluator(draft.body, context);
    llmIssues = evaluation.issues;
  }

  const allIssues = [...codeIssues, ...llmIssues];

  // No issues — pass through unchanged
  if (allIssues.length === 0) {
    return { draft: draft.body, wasRevised: false, issues: [], originalBeforeRevision: null };
  }

  // Issues found — revise if reviser available
  if (options.reviser) {
    const revised = await options.reviser(draft.body, allIssues, context);
    return { draft: revised, wasRevised: true, issues: allIssues, originalBeforeRevision: draft.body };
  }

  // No reviser — return with issues flagged but draft unchanged
  return { draft: draft.body, wasRevised: false, issues: allIssues, originalBeforeRevision: null };
}

// ── Code-based evaluation checks ─────────────────────────────────────────

function runCodeChecks(draft: Message, deal: DealContext): string[] {
  const issues: string[] = [];
  const body = draft.body.toLowerCase();

  // Check for unverifiable claims
  if (body.includes("wifi") && !deal.trip.specialRequirements.includes("wifi")) {
    issues.push("Draft mentions WiFi but no amenity data in deal context.");
  }
  if (body.includes("bed") && !deal.trip.specialRequirements.includes("bed")) {
    issues.push("Draft mentions bed/sleeping but no cabin config data.");
  }
  if (body.includes("catering included") && !deal.trip.specialRequirements.includes("catering")) {
    issues.push("Draft claims catering included but not in deal requirements.");
  }

  // Check pricing consistency
  if (deal.quote.osaPrice) {
    const priceStr = `$${deal.quote.osaPrice.toLocaleString()}`;
    if (body.includes("$") && !body.includes(priceStr.toLowerCase().replace(/,/g, "")) && !body.includes(priceStr.toLowerCase())) {
      // Draft mentions a price but it doesn't match OSA price — flag for review
      const draftPrice = body.match(/\$[\d,]+/);
      if (draftPrice) {
        const draftVal = parseFloat(draftPrice[0].replace(/[$,]/g, ""));
        if (Math.abs(draftVal - deal.quote.osaPrice) > 100) {
          issues.push(`Draft price ${draftPrice[0]} doesn't match OSA price ${priceStr}.`);
        }
      }
    }
  }

  return issues;
}
