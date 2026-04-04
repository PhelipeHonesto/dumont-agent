/**
 * Tests for stage regression — backward pipeline transitions.
 * Per spec: communication-layer.md section 2.7 (Dynamic Planning).
 *
 * The pipeline can go backwards when real-world deal flow changes:
 * - Client wants different aircraft → presented → estimated
 * - Client rejects operator → presented → sourced
 * - Quote expired → quoted → sourced
 * - Operator unavailable → sourced → estimated
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  regressStage,
  isAllowedRegression,
} from "../src/orchestrator/stage-transitions.js";
import { PipelineError } from "../src/utils/errors.js";
import { createDealContext, updateDealContext, _resetDealCounter } from "../src/orchestrator/deal-context-manager.js";
import { advanceStage } from "../src/orchestrator/stage-transitions.js";
import type { DealContext } from "../src/schemas/deal-context.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function advanceTo(ctx: DealContext, target: string) {
  const path: Record<string, string[]> = {
    qualified: ["qualified"],
    estimated: ["qualified", "estimated"],
    sourced: ["qualified", "estimated", "sourced"],
    quoted: ["qualified", "estimated", "sourced", "quoted"],
    presented: ["qualified", "estimated", "sourced", "quoted", "presented"],
    confirmed: ["qualified", "estimated", "sourced", "quoted", "presented", "confirmed"],
    closed: ["qualified", "estimated", "sourced", "quoted", "presented", "confirmed", "closed"],
  };
  for (const stage of path[target] ?? []) {
    advanceStage(ctx, stage as DealContext["stage"]);
  }
}

function makeFullDealCtx(): DealContext {
  const ctx = createDealContext("sim");
  updateDealContext(ctx, {
    trip: {
      departure: "KTEB", arrival: "KPBI", date: "2026-04-15",
      pax: 4, aircraftClass: "light", aircraftType: "Phenom 300E",
      isRoundTrip: false, specialRequirements: [],
    },
    client: {
      name: "Test Client", contact: "test@example.com", type: "new",
      budget: { min: 25000, max: 40000 }, substitutionPref: null,
      qualified: true, qualificationReason: "Fully qualified.",
    },
    sourcing: {
      selectedOperator: {
        operatorId: "op_001", operatorName: "Elite Aviation",
        phone: "+1-555-0100", baseAirport: "KTEB",
        aircraftType: "Phenom 300E", aircraftTail: "N300EA",
        score: 0.85,
        scoreBreakdown: { proximity: 0.9, laneHistory: 0.7, responseTime: 0.8, pricingAccuracy: 0.85, relationship: 0.8 },
        distanceToDeparture: 0,
      },
      backupOperator: null,
      rankingReason: "Elite Aviation selected",
      laneHistory: [],
    },
    estimate: {
      source: "aviapages", flightTime: 150,
      priceRange: { low: 25000, high: 35000 },
      fuelBurn: 280, positioning: null,
      calculatedAt: new Date().toISOString(),
    },
    quote: {
      operatorPrice: 28000, osaPrice: 30435, margin: 0.08,
      validUntil: new Date(Date.now() + 120 * 60_000).toISOString(),
      aircraft: { type: "Phenom 300E", tail: "N300EA", year: 2022 },
      quotedAt: new Date().toISOString(),
    },
    presentation: {
      sentAt: new Date().toISOString(), viewedAt: null,
      clientDecision: "pending", decisionAt: null,
      timerStarted: new Date().toISOString(),
    },
  });
  return ctx;
}

// ── isAllowedRegression ──────────────────────────────────────────────────

describe("isAllowedRegression", () => {
  beforeEach(() => _resetDealCounter());

  it("allows presented → estimated", () => {
    expect(isAllowedRegression("presented", "estimated")).toBe(true);
  });

  it("allows presented → sourced", () => {
    expect(isAllowedRegression("presented", "sourced")).toBe(true);
  });

  it("allows quoted → sourced", () => {
    expect(isAllowedRegression("quoted", "sourced")).toBe(true);
  });

  it("allows sourced → estimated", () => {
    expect(isAllowedRegression("sourced", "estimated")).toBe(true);
  });

  it("blocks closed → anything", () => {
    expect(isAllowedRegression("closed", "estimated")).toBe(false);
    expect(isAllowedRegression("closed", "intake")).toBe(false);
  });

  it("blocks failed → anything", () => {
    expect(isAllowedRegression("failed", "estimated")).toBe(false);
    expect(isAllowedRegression("failed", "sourced")).toBe(false);
  });

  it("blocks regression to intake", () => {
    expect(isAllowedRegression("presented", "intake")).toBe(false);
    expect(isAllowedRegression("sourced", "intake")).toBe(false);
  });

  it("blocks regression to qualified", () => {
    expect(isAllowedRegression("estimated", "qualified")).toBe(false);
  });

  it("blocks forward transitions (not a regression)", () => {
    expect(isAllowedRegression("estimated", "sourced")).toBe(false);
    expect(isAllowedRegression("intake", "qualified")).toBe(false);
  });
});

// ── regressStage: data clearing ──────────────────────────────────────────

describe("regressStage data clearing", () => {
  beforeEach(() => _resetDealCounter());

  it("presented → estimated clears sourcing + quote + presentation", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    regressStage(ctx, "estimated", "Client wants a lighter jet");

    expect(ctx.stage).toBe("estimated");
    // Sourcing cleared
    expect(ctx.sourcing.selectedOperator).toBeNull();
    expect(ctx.sourcing.backupOperator).toBeNull();
    expect(ctx.sourcing.rankingReason).toBe("");
    // Quote cleared
    expect(ctx.quote.operatorPrice).toBeNull();
    expect(ctx.quote.osaPrice).toBeNull();
    expect(ctx.quote.aircraft).toBeNull();
    // Presentation cleared
    expect(ctx.presentation.sentAt).toBeNull();
    expect(ctx.presentation.clientDecision).toBeNull();
    expect(ctx.presentation.timerStarted).toBeNull();
  });

  it("presented → sourced clears quote + presentation but keeps estimate", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    regressStage(ctx, "sourced", "Client rejects operator");

    expect(ctx.stage).toBe("sourced");
    // Quote cleared
    expect(ctx.quote.operatorPrice).toBeNull();
    expect(ctx.quote.osaPrice).toBeNull();
    // Presentation cleared
    expect(ctx.presentation.sentAt).toBeNull();
    // Estimate preserved
    expect(ctx.estimate.priceRange).not.toBeNull();
    expect(ctx.estimate.priceRange!.low).toBe(25000);
  });

  it("quoted → sourced clears quote + presentation", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "quoted");

    regressStage(ctx, "sourced", "Quote expired");

    expect(ctx.stage).toBe("sourced");
    expect(ctx.quote.operatorPrice).toBeNull();
    expect(ctx.quote.osaPrice).toBeNull();
    expect(ctx.presentation.sentAt).toBeNull();
    // Estimate preserved
    expect(ctx.estimate.priceRange).not.toBeNull();
  });

  it("sourced → estimated clears sourcing data", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "sourced");

    regressStage(ctx, "estimated", "Operator not available, changes scope");

    expect(ctx.stage).toBe("estimated");
    expect(ctx.sourcing.selectedOperator).toBeNull();
    expect(ctx.sourcing.rankingReason).toBe("");
    // Estimate preserved
    expect(ctx.estimate.priceRange).not.toBeNull();
  });
});

// ── regressStage: error cases ────────────────────────────────────────────

describe("regressStage error cases", () => {
  beforeEach(() => _resetDealCounter());

  it("throws PipelineError for regression from closed", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "closed");

    expect(() => regressStage(ctx, "estimated", "test")).toThrow(PipelineError);
  });

  it("throws PipelineError for regression from failed", () => {
    const ctx = createDealContext("sim");
    advanceStage(ctx, "failed");

    expect(() => regressStage(ctx, "estimated", "test")).toThrow(PipelineError);
  });

  it("throws PipelineError for regression to intake", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    expect(() => regressStage(ctx, "intake", "test")).toThrow(PipelineError);
  });

  it("error message includes from and to stages", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "closed");

    try {
      regressStage(ctx, "estimated", "test");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PipelineError);
      const pe = err as InstanceType<typeof PipelineError>;
      expect(pe.message).toContain("closed");
      expect(pe.message).toContain("estimated");
    }
  });
});

// ── regressStage: history logging ────────────────────────────────────────

describe("regressStage history logging", () => {
  beforeEach(() => _resetDealCounter());

  it("logs regression to stageHistory with reason", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");
    const historyBefore = ctx.stageHistory.length;

    regressStage(ctx, "estimated", "Client wants a lighter jet");

    // Should have added a regression entry + a new stage entry
    expect(ctx.stageHistory.length).toBe(historyBefore + 2);

    const regressionEntry = ctx.stageHistory[ctx.stageHistory.length - 2]!;
    expect(regressionEntry.stage).toContain("regression");
    expect(regressionEntry.stage).toContain("presented");
    expect(regressionEntry.stage).toContain("estimated");

    const newStageEntry = ctx.stageHistory[ctx.stageHistory.length - 1]!;
    expect(newStageEntry.stage).toBe("estimated");
    expect(newStageEntry.duration).toBeNull();
  });

  it("updates updatedAt timestamp", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    regressStage(ctx, "estimated", "test");

    // updatedAt should be a valid ISO timestamp (may be same ms in fast tests)
    expect(ctx.updatedAt).toBeDefined();
    expect(new Date(ctx.updatedAt).getTime()).toBeGreaterThan(0);
    // Verify reason was stored in outcome notes
    expect(ctx.outcome.notes).toContain("Regression presented→estimated: test");
  });
});

// ── regressStage: preserves unrelated data ───────────────────────────────

describe("regressStage preserves client and trip data", () => {
  beforeEach(() => _resetDealCounter());

  it("preserves client data on regression", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    regressStage(ctx, "estimated", "test");

    expect(ctx.client.name).toBe("Test Client");
    expect(ctx.client.contact).toBe("test@example.com");
    expect(ctx.client.budget).toEqual({ min: 25000, max: 40000 });
    expect(ctx.client.qualified).toBe(true);
  });

  it("preserves trip data on regression", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    regressStage(ctx, "estimated", "test");

    expect(ctx.trip.departure).toBe("KTEB");
    expect(ctx.trip.arrival).toBe("KPBI");
    expect(ctx.trip.pax).toBe(4);
    expect(ctx.trip.date).toBe("2026-04-15");
  });

  it("preserves estimate data when regressing to sourced", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    regressStage(ctx, "sourced", "test");

    expect(ctx.estimate.source).toBe("aviapages");
    expect(ctx.estimate.priceRange!.low).toBe(25000);
    expect(ctx.estimate.flightTime).toBe(150);
  });

  it("preserves guardian data on regression", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");
    ctx.guardian.passes.push({
      stage: "intake", passed: true, checks: [], timestamp: new Date().toISOString(),
    });

    regressStage(ctx, "estimated", "test");

    expect(ctx.guardian.passes.length).toBe(1);
  });
});

// ── Double regression ────────────────────────────────────────────────────

describe("double regression", () => {
  beforeEach(() => _resetDealCounter());

  it("supports presented → sourced → estimated", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    // First regression: presented → sourced
    regressStage(ctx, "sourced", "Client rejects operator");
    expect(ctx.stage).toBe("sourced");
    expect(ctx.quote.operatorPrice).toBeNull();
    // Estimate still intact
    expect(ctx.estimate.priceRange).not.toBeNull();

    // Second regression: sourced → estimated
    regressStage(ctx, "estimated", "Need different aircraft class");
    expect(ctx.stage).toBe("estimated");
    expect(ctx.sourcing.selectedOperator).toBeNull();
    // Estimate still intact (we regressed TO estimated, not past it)
    expect(ctx.estimate.priceRange).not.toBeNull();
  });

  it("logs both regressions to stageHistory", () => {
    const ctx = makeFullDealCtx();
    advanceTo(ctx, "presented");

    regressStage(ctx, "sourced", "Reason 1");
    regressStage(ctx, "estimated", "Reason 2");

    const regressions = ctx.stageHistory.filter((h) =>
      h.stage.startsWith("regression:"),
    );
    expect(regressions.length).toBe(2);
    expect(regressions[0]!.stage).toContain("presented");
    expect(regressions[0]!.stage).toContain("sourced");
    expect(regressions[1]!.stage).toContain("sourced");
    expect(regressions[1]!.stage).toContain("estimated");
  });
});
