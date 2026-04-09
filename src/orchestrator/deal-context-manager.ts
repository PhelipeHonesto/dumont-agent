/**
 * Deal Context Manager — creates and mutates deal contexts.
 *
 * Capabilities never mutate the context directly. They return data;
 * the orchestrator uses this manager to merge it in.
 *
 * Evolved from ~/osa/simulator/src/orchestrator/deal-context-manager.ts
 * Key change: DealContext is a flat object matching the spec, not agent-sectioned.
 */

import type { DealContext, DealMode } from "../schemas/deal-context.js";
import { ulid } from "ulid";

function generateDealId(mode: DealMode): string {
  const prefix = mode === "sim" ? "SIM" : "LIVE";
  return `${prefix}_${ulid()}`;
}

/**
 * Create a fresh DealContext with all sections at default/empty state.
 */
export function createDealContext(mode: DealMode): DealContext {
  const now = new Date().toISOString();

  return {
    id: generateDealId(mode),
    createdAt: now,
    updatedAt: now,
    mode,

    stage: "intake",
    stageHistory: [{ stage: "intake", timestamp: now, duration: null }],

    client: {
      name: "",
      contact: "",
      type: "new",
      budget: null,
      substitutionPref: null,
      qualified: false,
      qualificationReason: null,
    },

    trip: {
      departure: "",
      arrival: "",
      date: "",
      pax: 0,
      aircraftClass: null,
      aircraftType: null,
      isRoundTrip: false,
      specialRequirements: [],
    },

    guardian: {
      passes: [],
      currentStatus: "clear",
      blockReason: null,
    },

    estimate: {
      source: "aviapages",
      flightTime: null,
      priceRange: null,
      fuelBurn: null,
      positioning: null,
      calculatedAt: null,
    },

    sourcing: {
      selectedOperator: null,
      backupOperator: null,
      rankingReason: "",
      laneHistory: [],
    },

    quote: {
      operatorPrice: null,
      osaPrice: null,
      margin: null,
      validUntil: null,
      aircraft: null,
      quotedAt: null,
    },

    presentation: {
      sentAt: null,
      viewedAt: null,
      clientDecision: null,
      decisionAt: null,
      timerStarted: null,
    },

    outcome: {
      result: null,
      estimateVsActual: null,
      operatorResponseTime: null,
      totalDealTime: null,
      revenue: null,
      notes: null,
    },
  };
}

/**
 * Update specific fields of the deal context via shallow merge per section.
 * Only the orchestrator should call this — capabilities return data, they don't mutate.
 * @param ctx - The deal context to update (mutated in place).
 * @param updates - Partial section updates to merge.
 */
export function updateDealContext(
  ctx: DealContext,
  updates: Partial<Pick<DealContext, "client" | "trip" | "guardian" | "estimate" | "sourcing" | "quote" | "presentation" | "outcome">>,
): void {
  for (const [section, data] of Object.entries(updates)) {
    const key = section as keyof typeof updates;
    if (data && typeof data === "object" && ctx[key] && typeof ctx[key] === "object") {
      Object.assign(ctx[key], data);
    }
  }
  ctx.updatedAt = new Date().toISOString();
}

/**
 * Returns a deep-cloned snapshot. Capabilities receive this — mutations
 * to the snapshot don't affect the original.
 */
export function snapshotContext(ctx: DealContext): DealContext {
  return structuredClone(ctx);
}

/** No-op — kept for backwards compatibility with tests. ULIDs are globally unique. */
export function _resetDealCounter(): void {
  // ULIDs don't need resetting — they're globally unique by design.
}
