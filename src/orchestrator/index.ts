/**
 * Orchestrator — the PIC of every deal.
 *
 * Single pipeline controller that invokes capabilities in sequence,
 * runs Guardian validation at every stage, and writes outcomes to memory.
 *
 * Per spec: orchestrator.md
 *
 * Pipeline:
 *   1. INTAKE    — parse request + qualify client
 *   2. ESTIMATE  — Aviapages price estimate + budget gate
 *   3. SOURCE    — select ONE operator + backup
 *   4. QUOTE     — human-in-the-loop real quote (day 1-50)
 *   5. PRESENT   — client-facing OSA quote
 *   6. CONFIRM   — client decision
 *   7. LEARN     — write to memory
 *
 * Guardian runs after every stage (1-5). If blocked, pipeline stops.
 */

import type { DealContext, DealMode, GuardianPass } from "../schemas/deal-context.js";
import {
  createDealContext,
  updateDealContext,
  snapshotContext,
} from "./deal-context-manager.js";
import { advanceStage } from "./stage-transitions.js";
import type { ContextFactoryStores } from "./context-factory.js";

// ── Capability Signatures ────────────────────────────────────────────────
// Each capability receives a snapshot and returns section data.
// The orchestrator merges results into the context.

export interface IntakeResult {
  client: DealContext["client"];
  trip: DealContext["trip"];
}

export interface EstimateResult {
  estimate: DealContext["estimate"];
}

export interface SourcingResult {
  sourcing: DealContext["sourcing"];
}

export interface QuoteResult {
  quote: DealContext["quote"];
}

export interface ScenarioResult {
  presentation: DealContext["presentation"];
}

export interface GuardianResult {
  pass: GuardianPass;
}

export interface Capabilities {
  intake: (rawRequest: string, ctx: DealContext) => Promise<IntakeResult>;
  estimate: (ctx: DealContext) => Promise<EstimateResult>;
  sourcing: (ctx: DealContext) => Promise<SourcingResult>;
  quote: (ctx: DealContext) => Promise<QuoteResult>;
  scenario: (ctx: DealContext) => Promise<ScenarioResult>;
  guardian: (stage: string, ctx: DealContext) => Promise<GuardianResult>;
}

// ── Pipeline Result ──────────────────────────────────────────────────────

export type PipelineOutcome =
  | "presented"           // happy path — quote sent to client
  | "awaiting_quote"      // paused at step 4 — waiting for human
  | "failed_intake"
  | "failed_qualification"
  | "failed_budget"
  | "failed_guardian"
  | "failed_sourcing"
  | "failed_error";

export interface PipelineResult {
  outcome: PipelineOutcome;
  dealContext: DealContext;
  wallClockMs: number;
  failReason?: string;
}

export interface PipelineOptions {
  mode: DealMode;
  capabilities: Capabilities;
  /** Composite object stores for context-aware pipeline stages. */
  stores?: ContextFactoryStores;
}

// ── Pre/Post Hooks (ruvnet pattern) ──────────────────────────────────────

export type HookFn = (ctx: DealContext, stage: string) => void | Promise<void>;

export interface PipelineHooks {
  onStageEnter?: HookFn;
  onStageExit?: HookFn;
  onGuardianPass?: (ctx: DealContext, pass: GuardianPass) => void | Promise<void>;
  onPipelineComplete?: (result: PipelineResult) => void | Promise<void>;
}

// ── Main Pipeline ────────────────────────────────────────────────────────

export async function runPipeline(
  rawRequest: string,
  options: PipelineOptions,
  hooks?: PipelineHooks,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const { mode, capabilities } = options;
  const ctx = createDealContext(mode);

  const fail = (outcome: PipelineOutcome, reason: string): PipelineResult => {
    ctx.stage = "failed";
    ctx.outcome.notes = reason;
    const result: PipelineResult = {
      outcome,
      dealContext: ctx,
      wallClockMs: Date.now() - startTime,
      failReason: reason,
    };
    hooks?.onPipelineComplete?.(result);
    return result;
  };

  // Helper: run Guardian and check if pipeline should stop
  async function runGuardian(stage: string): Promise<boolean> {
    await hooks?.onStageEnter?.(ctx, `guardian:${stage}`);

    const guardianResult = await capabilities.guardian(stage, snapshotContext(ctx));
    const pass = guardianResult.pass;

    ctx.guardian.passes.push(pass);
    if (!pass.passed) {
      ctx.guardian.currentStatus = "blocked";
      ctx.guardian.blockReason = pass.checks
        .filter((c) => !c.passed && c.severity === "critical")
        .map((c) => c.message)
        .join("; ");
    } else {
      const hasWarnings = pass.checks.some((c) => !c.passed && c.severity === "warning");
      ctx.guardian.currentStatus = hasWarnings ? "warning" : "clear";
    }
    ctx.updatedAt = new Date().toISOString();

    await hooks?.onGuardianPass?.(ctx, pass);
    await hooks?.onStageExit?.(ctx, `guardian:${stage}`);

    return ctx.guardian.currentStatus === "blocked";
  }

  try {
    // ── 1. INTAKE ──────────────────────────────────────────────────────
    await hooks?.onStageEnter?.(ctx, "intake");

    const intakeResult = await capabilities.intake(rawRequest, snapshotContext(ctx));
    updateDealContext(ctx, { client: intakeResult.client, trip: intakeResult.trip });

    await hooks?.onStageExit?.(ctx, "intake");

    // Guardian: is trip physically possible?
    const blockedAfterIntake = await runGuardian("intake");
    if (blockedAfterIntake) {
      return fail("failed_guardian", `Guardian blocked at intake: ${ctx.guardian.blockReason}`);
    }

    // Qualification gate
    if (!ctx.client.qualified) {
      return fail("failed_qualification", ctx.client.qualificationReason ?? "Client not qualified");
    }

    advanceStage(ctx, "qualified");

    // Budget gate — pipeline pauses if no budget (spec says ask client, not fail)
    if (!ctx.client.budget) {
      return fail("failed_budget", "No budget provided — pipeline paused for client input");
    }

    // ── 2. ESTIMATE ────────────────────────────────────────────────────
    advanceStage(ctx, "estimated");
    await hooks?.onStageEnter?.(ctx, "estimated");

    const estimateResult = await capabilities.estimate(snapshotContext(ctx));
    updateDealContext(ctx, { estimate: estimateResult.estimate });

    await hooks?.onStageExit?.(ctx, "estimated");

    // Guardian: does budget overlap estimate?
    const blockedAfterEstimate = await runGuardian("estimated");
    if (blockedAfterEstimate) {
      return fail("failed_budget", `Budget mismatch: ${ctx.guardian.blockReason}`);
    }

    // ── 3. SOURCE ──────────────────────────────────────────────────────
    advanceStage(ctx, "sourced");
    await hooks?.onStageEnter?.(ctx, "sourced");

    const sourcingResult = await capabilities.sourcing(snapshotContext(ctx));
    updateDealContext(ctx, { sourcing: sourcingResult.sourcing });

    await hooks?.onStageExit?.(ctx, "sourced");

    // Guardian: is operator certified?
    const blockedAfterSourcing = await runGuardian("sourced");
    if (blockedAfterSourcing) {
      return fail("failed_guardian", `Guardian blocked at sourcing: ${ctx.guardian.blockReason}`);
    }

    if (!ctx.sourcing.selectedOperator) {
      return fail("failed_sourcing", "No operator matched for this route");
    }

    // ── 4. QUOTE (human step, day 1-50) ────────────────────────────────
    // In SIM mode, the quote capability fills this from fixture data.
    // In LIVE mode, this pauses for human input.
    advanceStage(ctx, "quoted");
    await hooks?.onStageEnter?.(ctx, "quoted");

    if (mode === "live") {
      // Pipeline pauses here. Phelipe calls the operator, enters the quote.
      // The quote capability in live mode signals what to do.
      const quoteResult = await capabilities.quote(snapshotContext(ctx));
      updateDealContext(ctx, { quote: quoteResult.quote });

      if (!ctx.quote.operatorPrice) {
        return {
          outcome: "awaiting_quote",
          dealContext: ctx,
          wallClockMs: Date.now() - startTime,
        };
      }
    } else {
      const quoteResult = await capabilities.quote(snapshotContext(ctx));
      updateDealContext(ctx, { quote: quoteResult.quote });
    }

    await hooks?.onStageExit?.(ctx, "quoted");

    // Guardian: is quote within range?
    const blockedAfterQuote = await runGuardian("quoted");
    if (blockedAfterQuote) {
      return fail("failed_guardian", `Guardian blocked at quote: ${ctx.guardian.blockReason}`);
    }

    // ── 5. PRESENT ─────────────────────────────────────────────────────
    advanceStage(ctx, "presented");
    await hooks?.onStageEnter?.(ctx, "presented");

    const scenarioResult = await capabilities.scenario(snapshotContext(ctx));
    updateDealContext(ctx, { presentation: scenarioResult.presentation });
    ctx.presentation.sentAt = new Date().toISOString();
    ctx.presentation.timerStarted = new Date().toISOString();
    ctx.presentation.clientDecision = "pending";

    await hooks?.onStageExit?.(ctx, "presented");

    // Guardian: final sanity before presentation
    await runGuardian("presented");

    // ── Pipeline reaches presentation — remaining stages are async ────
    ctx.outcome.totalDealTime = (Date.now() - startTime) / 1000;

    const result: PipelineResult = {
      outcome: "presented",
      dealContext: ctx,
      wallClockMs: Date.now() - startTime,
    };

    await hooks?.onPipelineComplete?.(result);
    return result;

  } catch (err) {
    return fail("failed_error", err instanceof Error ? err.message : String(err));
  }
}

// ── Close Deal (Learning Loop) ──────────────��────────────────────────────

import type { DealStore } from "../memory/deal-store.js";
import type { DealRecord } from "../schemas/deal-record.js";
import type { DealOutcomeResult, CompositeStores } from "../memory/learning-loop.js";
import type { AirportCoords } from "../memory/learning-loop.js";
import { recordDeal } from "../memory/learning-loop.js";
import { calcEstimateDelta } from "../capabilities/quote.js";
import { evictDealTokenBudget } from "../utils/safe-llm-call.js";

export interface CloseDealOptions {
  /** The deal outcome result. */
  result: DealOutcomeResult;
  /** DealStore to persist the record. */
  dealStore: DealStore;
  /** Operator response time in seconds. */
  operatorResponseTime?: number | null;
  /** Airport coordinates for distance calculation. */
  airports?: Map<string, AirportCoords>;
  /** Additional notes. */
  notes?: string;
  /** Pipeline hooks. */
  hooks?: PipelineHooks;
  /** Composite object stores — updated on deal close if provided. */
  compositeStores?: CompositeStores;
}

/**
 * Close a deal — transitions stage, writes to learning loop, fires hooks.
 *
 * Called when:
 * - Client confirms → result = "closed", stage = confirmed → closed
 * - Client declines → result = "client_declined", stage → failed
 * - Quote expires → result = "expired", stage → failed
 * - Any other terminal outcome
 *
 * Per spec: "ALWAYS log deal outcomes to memory (even failed/rejected deals)"
 */
export function closeDeal(
  ctx: DealContext,
  options: CloseDealOptions,
): DealRecord {
  const { result, dealStore, operatorResponseTime, airports, notes, hooks, compositeStores } = options;

  const isClosed = result === "closed";

  // Update outcome section
  ctx.outcome.result = result;
  if (operatorResponseTime != null) {
    ctx.outcome.operatorResponseTime = operatorResponseTime;
  }
  if (notes) {
    ctx.outcome.notes = notes;
  }

  // Calculate revenue for closed deals
  if (isClosed && ctx.quote.osaPrice && ctx.quote.operatorPrice) {
    ctx.outcome.revenue = ctx.quote.osaPrice - ctx.quote.operatorPrice;
  }

  // Compute total deal time
  if (!ctx.outcome.totalDealTime) {
    ctx.outcome.totalDealTime = Math.round(
      (Date.now() - new Date(ctx.createdAt).getTime()) / 1000,
    );
  }

  // Update presentation decision tracking
  if (ctx.presentation.sentAt && !ctx.presentation.decisionAt) {
    ctx.presentation.decisionAt = new Date().toISOString();
  }
  if (isClosed) {
    ctx.presentation.clientDecision = "confirmed";
  } else if (result === "client_declined" || result === "lost_to_competition") {
    ctx.presentation.clientDecision = "declined";
  } else if (result === "expired") {
    ctx.presentation.clientDecision = "expired";
  }

  // Transition stage
  if (isClosed && ctx.stage === "presented") {
    advanceStage(ctx, "confirmed");
    advanceStage(ctx, "closed");
  } else if (isClosed && ctx.stage === "confirmed") {
    advanceStage(ctx, "closed");
  } else if (!isClosed && ctx.stage !== "failed") {
    advanceStage(ctx, "failed");
  }

  ctx.updatedAt = new Date().toISOString();

  // Write to learning loop + update composite objects
  const record = recordDeal(ctx, dealStore, {
    result,
    operatorResponseTime,
    airports,
    notes,
    compositeStores,
  });

  // Evict deal from token budget tracker (prevents memory leak)
  evictDealTokenBudget(ctx.id);

  // Compute estimate delta and store in outcome
  if (ctx.estimate.priceRange && ctx.quote.operatorPrice) {
    ctx.outcome.estimateVsActual = calcEstimateDelta(ctx.estimate.priceRange, ctx.quote.operatorPrice);
  }

  // Fire completion hook
  if (hooks?.onPipelineComplete) {
    const pipelineResult: PipelineResult = {
      outcome: isClosed ? "presented" : "failed_error",
      dealContext: ctx,
      wallClockMs: (ctx.outcome.totalDealTime ?? 0) * 1000,
    };
    hooks.onPipelineComplete(pipelineResult);
  }

  return record;
}

// Re-exports
export { createDealContext, updateDealContext, snapshotContext } from "./deal-context-manager.js";
export { advanceStage, isValidTransition, InvalidTransitionError, regressStage, isAllowedRegression } from "./stage-transitions.js";
export {
  buildIntakeContext,
  buildGuardianContext,
  buildEstimateContext,
  buildPriceWallContext,
  buildSourcingContext,
  buildQuoteContext,
  buildPresentContext,
  buildRespondContext,
} from "./context-factory.js";
export type {
  IntakeContext,
  GuardianContext,
  EstimateContext,
  PriceWallContext,
  SourcingContext,
  QuoteContext,
  PresentContext,
  RespondContext,
  ContextFactoryStores,
} from "./context-factory.js";
