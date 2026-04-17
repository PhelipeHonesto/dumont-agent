/**
 * Tests for Deal Context schema, manager, and stage transitions.
 * Build sequence step 1: verify the foundation before capabilities.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DealContextSchema,
  DealStage,
  type DealContext,
} from "../src/schemas/deal-context.js";
import {
  createDealContext,
  updateDealContext,
  snapshotContext,
} from "../src/orchestrator/deal-context-manager.js";
import {
  advanceStage,
  isValidTransition,
  InvalidTransitionError,
} from "../src/orchestrator/stage-transitions.js";

describe("DealContext Schema", () => {
  it("creates a valid deal context", () => {
    const ctx = createDealContext("sim");
    const result = DealContextSchema.safeParse(ctx);
    expect(result.success).toBe(true);
  });

  it("creates context with correct defaults", () => {
    const ctx = createDealContext("sim");
    expect(ctx.mode).toBe("sim");
    expect(ctx.stage).toBe("intake");
    expect(ctx.client.qualified).toBe(false);
    expect(ctx.guardian.currentStatus).toBe("clear");
    expect(ctx.guardian.passes).toHaveLength(0);
    expect(ctx.estimate.priceRange).toBeNull();
    expect(ctx.sourcing.selectedOperator).toBeNull();
    expect(ctx.quote.operatorPrice).toBeNull();
    expect(ctx.presentation.clientDecision).toBeNull();
    expect(ctx.outcome.result).toBeNull();
  });

  it("generates unique deal IDs with mode prefix", () => {
    const sim = createDealContext("sim");
    const live = createDealContext("live");
    expect(sim.id).toMatch(/^SIM_/);
    expect(live.id).toMatch(/^LIVE_/);
    expect(sim.id).not.toBe(live.id);
  });

  it("validates all DealStage values", () => {
    const stages = [
      "intake", "qualified", "estimated", "sourced",
      "quoted", "presented", "confirmed", "closed", "failed",
    ];
    for (const stage of stages) {
      expect(DealStage.safeParse(stage).success).toBe(true);
    }
    expect(DealStage.safeParse("invalid").success).toBe(false);
  });
});

describe("Deal Context Manager", () => {
  it("updates context sections via shallow merge", () => {
    const ctx = createDealContext("sim");
    updateDealContext(ctx, {
      client: { name: "Test Client", contact: "test@example.com", qualified: true },
    });
    expect(ctx.client.name).toBe("Test Client");
    expect(ctx.client.type).toBe("new"); // unchanged
  });

  it("snapshot returns a deep clone", () => {
    const ctx = createDealContext("sim");
    const snap = snapshotContext(ctx);
    snap.client.name = "Modified";
    expect(ctx.client.name).toBe(""); // original unchanged
  });

  it("updates the updatedAt timestamp", () => {
    const ctx = createDealContext("sim");
    const before = ctx.updatedAt;
    // Small delay to ensure timestamp differs
    updateDealContext(ctx, { client: { name: "X" } });
    expect(ctx.updatedAt).toBeDefined();
  });
});

describe("Stage Transitions", () => {
  it("allows the happy path", () => {
    const ctx = createDealContext("sim");
    advanceStage(ctx, "qualified");
    expect(ctx.stage).toBe("qualified");

    advanceStage(ctx, "estimated");
    expect(ctx.stage).toBe("estimated");

    advanceStage(ctx, "sourced");
    advanceStage(ctx, "quoted");
    advanceStage(ctx, "presented");
    advanceStage(ctx, "confirmed");
    advanceStage(ctx, "closed");

    expect(ctx.stage).toBe("closed");
    expect(ctx.stageHistory).toHaveLength(8); // intake + 7 transitions
  });

  it("allows any stage to transition to failed", () => {
    for (const stage of ["intake", "qualified", "estimated", "sourced", "quoted", "presented"] as const) {
      expect(isValidTransition(stage, "failed")).toBe(true);
    }
  });

  it("rejects invalid transitions", () => {
    const ctx = createDealContext("sim");
    expect(() => advanceStage(ctx, "closed")).toThrow(InvalidTransitionError);
    expect(() => advanceStage(ctx, "sourced")).toThrow(InvalidTransitionError);
  });

  it("tracks stage history with timestamps", () => {
    const ctx = createDealContext("sim");
    advanceStage(ctx, "qualified");

    expect(ctx.stageHistory).toHaveLength(2);
    expect(ctx.stageHistory[0]!.stage).toBe("intake");
    expect(ctx.stageHistory[0]!.duration).not.toBeNull(); // closed
    expect(ctx.stageHistory[1]!.stage).toBe("qualified");
    expect(ctx.stageHistory[1]!.duration).toBeNull(); // open
  });

  it("records duration on stage exit", () => {
    const ctx = createDealContext("sim");
    advanceStage(ctx, "qualified");
    const intakeEntry = ctx.stageHistory[0]!;
    expect(typeof intakeEntry.duration).toBe("number");
    expect(intakeEntry.duration!).toBeGreaterThanOrEqual(0);
  });
});
