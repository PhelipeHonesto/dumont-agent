/**
 * Stage Transitions — enforces valid pipeline stage progression.
 *
 * Forward transitions: intake → qualified → estimated → sourced → quoted → presented → confirmed → closed
 * Any stage can transition to "failed".
 *
 * Regressions (v2.1): backward transitions when real-world deal flow changes.
 * Per spec: communication-layer.md section 2.7 (Dynamic Planning).
 * Pattern: Anthropic "Building Effective Agents" — dynamic planning.
 */

import type { DealContext, DealStage } from "../schemas/deal-context.js";
import { PipelineError } from "../utils/errors.js";

const VALID_TRANSITIONS: Record<string, Set<string>> = {
  intake:           new Set(["qualified", "failed"]),
  qualified:        new Set(["estimated", "failed"]),
  estimated:        new Set(["sourced", "failed"]),
  sourced:          new Set(["quoted", "failed"]),
  quoted:           new Set(["presented", "awaiting_review", "failed"]),
  awaiting_review:  new Set(["presented", "failed"]),
  presented:        new Set(["confirmed", "failed"]),
  confirmed:        new Set(["closed", "failed"]),
};

/**
 * Check if a stage transition is valid without throwing.
 * @param from - Current stage.
 * @param to - Target stage.
 * @returns True if the transition is allowed.
 */
export function isValidTransition(from: DealStage, to: DealStage): boolean {
  if (to === "failed") return true;
  const allowed = VALID_TRANSITIONS[from];
  return allowed !== undefined && allowed.has(to);
}

/**
 * Advance the deal context to a new pipeline stage.
 * Closes the current stage history entry with duration, opens a new one.
 * @param ctx - The deal context to advance (mutated in place).
 * @param to - The target stage.
 * @throws {InvalidTransitionError} If the transition is not allowed.
 */
export function advanceStage(ctx: DealContext, to: DealStage): void {
  const from = ctx.stage;
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }

  const now = new Date().toISOString();

  // Close current stage entry with duration
  const current = ctx.stageHistory[ctx.stageHistory.length - 1];
  if (current && current.duration === null) {
    current.duration = Date.now() - new Date(current.timestamp).getTime();
  }

  ctx.stage = to;
  ctx.stageHistory.push({ stage: to, timestamp: now, duration: null });
  ctx.updatedAt = now;
}

/**
 * Get all valid target stages from a given stage.
 * @param from - The current stage.
 * @returns Array of valid target stages.
 */
export function getValidTargets(from: DealStage): DealStage[] {
  const specific = VALID_TRANSITIONS[from];
  if (!specific) return ["failed"];
  return [...specific] as DealStage[];
}

export class InvalidTransitionError extends Error {
  public readonly from: DealStage;
  public readonly to: DealStage;

  constructor(from: DealStage, to: DealStage) {
    const targets = getValidTargets(from).join(", ");
    super(`Invalid stage transition: "${from}" → "${to}". Valid targets: ${targets}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ── Stage Regression (Dynamic Planning) ──────────────────────────────────
// Per spec: communication-layer.md section 2.7
// Pipeline goes backwards when deal conditions change.

/**
 * Allowed backward transitions.
 * Key: "from:to", value: description of when this regression applies.
 * NOT allowed: any regression past intake, from closed, or from failed.
 */
const ALLOWED_REGRESSIONS: Record<string, string> = {
  "presented:estimated": "Client wants different aircraft class or cheaper option",
  "presented:sourced": "Client rejects specific operator",
  "quoted:sourced": "Quote expired, need fresh operator",
  "sourced:estimated": "Operator not available, changes aircraft scope",
};

/** Terminal stages that cannot regress. */
const TERMINAL_STAGES = new Set<string>(["closed", "failed"]);

/** Stages that cannot be regression targets (too far back — start a new deal). */
const NO_REGRESS_TARGETS = new Set<string>(["intake", "qualified"]);

/**
 * Check if a backward stage transition (regression) is allowed.
 * @param from - Current stage.
 * @param to - Target stage to regress to.
 * @returns True if the regression is in the allowed set.
 */
export function isAllowedRegression(from: DealStage, to: DealStage): boolean {
  if (TERMINAL_STAGES.has(from)) return false;
  if (NO_REGRESS_TARGETS.has(to)) return false;
  return `${from}:${to}` in ALLOWED_REGRESSIONS;
}

/** Empty shapes for clearing pipeline sections on regression. */
const EMPTY_SOURCING: DealContext["sourcing"] = {
  selectedOperator: null,
  backupOperator: null,
  rankingReason: "",
  laneHistory: [],
};

const EMPTY_QUOTE: DealContext["quote"] = {
  operatorPrice: null,
  osaPrice: null,
  margin: null,
  validUntil: null,
  aircraft: null,
  quotedAt: null,
};

const EMPTY_PRESENTATION: DealContext["presentation"] = {
  sentAt: null,
  viewedAt: null,
  clientDecision: null,
  decisionAt: null,
  timerStarted: null,
};

/**
 * Regress the deal to an earlier pipeline stage.
 * Clears invalidated downstream data so the pipeline can re-run from the target stage.
 *
 * Allowed regressions:
 * - presented → estimated (client wants different aircraft)
 * - presented → sourced (client rejects operator)
 * - quoted → sourced (quote expired)
 * - sourced → estimated (operator unavailable, scope change)
 *
 * @param ctx - The deal context to regress (mutated in place).
 * @param to - The target stage to regress to.
 * @param reason - Human-readable reason for the regression (logged to history).
 * @throws {PipelineError} If the regression is not allowed.
 */
export function regressStage(ctx: DealContext, to: DealStage, reason: string): void {
  const from = ctx.stage;

  if (!isAllowedRegression(from, to)) {
    throw new PipelineError(
      `Cannot regress from "${from}" to "${to}". Allowed regressions: ${Object.keys(ALLOWED_REGRESSIONS).join(", ")}`,
      { dealId: ctx.id, stage: from, outcome: "regression_blocked" },
    );
  }

  const now = new Date().toISOString();

  // Close current stage entry
  const current = ctx.stageHistory[ctx.stageHistory.length - 1];
  if (current && current.duration === null) {
    current.duration = Date.now() - new Date(current.timestamp).getTime();
  }

  // Log regression as a typed history entry
  ctx.stageHistory.push({
    stage: to,
    timestamp: now,
    duration: 0,
    regression: { from, to, reason },
  });

  // Store reason in outcome notes (append, don't overwrite)
  const regressionNote = `Regression ${from}→${to}: ${reason}`;
  ctx.outcome.notes = ctx.outcome.notes
    ? `${ctx.outcome.notes}; ${regressionNote}`
    : regressionNote;

  // Clear invalidated data based on target stage
  switch (to) {
    case "estimated":
      // Re-estimating: clear sourcing + quote + presentation
      ctx.sourcing = { ...EMPTY_SOURCING };
      ctx.quote = { ...EMPTY_QUOTE };
      ctx.presentation = { ...EMPTY_PRESENTATION };
      break;

    case "sourced":
      // Re-sourcing: clear quote + presentation (estimate stays)
      ctx.quote = { ...EMPTY_QUOTE };
      ctx.presentation = { ...EMPTY_PRESENTATION };
      break;
  }

  // Set the new stage
  ctx.stage = to;
  ctx.stageHistory.push({ stage: to, timestamp: now, duration: null });
  ctx.updatedAt = now;
}
