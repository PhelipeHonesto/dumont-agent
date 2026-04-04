/**
 * Configuration for the Dumont Agent pipeline.
 * Model selection, timeouts, pricing policy.
 *
 * Migrated from simulator config with updates for new architecture.
 */

export const MODELS = {
  intake: "claude-sonnet-4-20250514",
  guardian: "claude-haiku-4-5-20251001",
  quote: "claude-sonnet-4-20250514",
  sourcing: "claude-haiku-4-5-20251001",
  scenario: "claude-sonnet-4-20250514",
  recovery: "claude-haiku-4-5-20251001",
} as const;

export const TEMPERATURES = {
  intake: 0.3,
  guardian: 0,
  quote: 0,
  sourcing: 0,
  scenario: 0.5,
} as const;

export const TIMEOUTS_MS = {
  intake: 30_000,
  guardian: 10_000,
  quote: 15_000,
  sourcing: 10_000,
  scenario: 15_000,
  pipeline: 120_000,
} as const;

export const RETRY_CONFIG = {
  maxRetries: 3,
  backoffMultiplier: 1.5,
} as const;

export const MARGIN_POLICY = {
  target: 0.08,      // 8% target margin
  min: 0.06,         // 6% floor
  max: 0.15,         // 15% ceiling
} as const;

export const QUOTE_VALIDITY = {
  defaultMinutes: 120,
  alertAtPercent: 0.70,
  urgentAtPercent: 0.90,
} as const;

export const ESTIMATE_TOLERANCE = {
  /** Quote beyond this delta from estimate triggers Guardian warning */
  warningThreshold: 0.25,
} as const;

/** Sourcing capability scoring thresholds. */
export const SOURCING_SCORING = {
  /** Cold-start default for factors with no historical data. */
  coldStartDefault: 0.5,
  /** Deals needed for full confidence in lane history blending. */
  laneConfidenceThreshold: 10,
  /** Relationship score: deals needed to reach 1.0 (linear scale). */
  relationshipMaxDeals: 20,
  /** Proximity score thresholds (nm → score). */
  proximity: [
    { maxNm: 25, score: 1.0 },
    { maxNm: 50, score: 0.95 },
    { maxNm: 150, score: 0.85 },
    { maxNm: 300, score: 0.70 },
    { maxNm: 500, score: 0.50 },
    { maxNm: 1000, score: 0.30 },
  ],
  proximityDefault: 0.10,
  /** Response time thresholds (seconds → score). */
  responseTime: [
    { maxSec: 1800, score: 1.0 },
    { maxSec: 3600, score: 0.85 },
    { maxSec: 7200, score: 0.70 },
    { maxSec: 14400, score: 0.50 },
    { maxSec: 28800, score: 0.30 },
  ],
  responseTimeDefault: 0.10,
  /** Pricing accuracy thresholds (abs delta fraction → score). */
  pricingAccuracy: [
    { maxDelta: 0.05, score: 1.0 },
    { maxDelta: 0.10, score: 0.85 },
    { maxDelta: 0.15, score: 0.70 },
    { maxDelta: 0.25, score: 0.50 },
  ],
  pricingAccuracyDefault: 0.30,
} as const;

/** Guardian validation thresholds. */
export const GUARDIAN_THRESHOLDS = {
  /** Minimum quote validity window in minutes. */
  quoteValidityMinMinutes: 30,
  /** Estimate floor below which we flag as suspiciously low. */
  estimateSanityFloor: 1000,
  /** Safety margins applied to aircraft limits. */
  safetyMargins: {
    runway: 1.10,
    range: 1.10,
  },
} as const;

/** Budget estimation range applied when client says "around $X". */
export const BUDGET_ESTIMATION = {
  /** Lower bound multiplier (e.g. "around $30k" → $25,500). */
  lowMultiplier: 0.85,
  /** Upper bound multiplier (e.g. "around $30k" → $34,500). */
  highMultiplier: 1.15,
} as const;
