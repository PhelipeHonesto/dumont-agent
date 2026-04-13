/**
 * Deal Outcome — structured record of how a deal resolved.
 *
 * One row per deal. Feeds the learning loop's pricing accuracy,
 * operator reliability, and client conversion intelligence.
 *
 * All money fields are integer cents. price_error_pct is computed
 * as abs(actual - quoted) / actual * 100.
 */

import { z } from "zod";

export const ReasonLost = z.enum(["price", "timing", "aircraft", "competitor", "other"]);
export type ReasonLost = z.infer<typeof ReasonLost>;

export const DealOutcomeRecordSchema = z.object({
  id: z.number().int().positive().optional(),       // auto-increment PK
  dealId: z.string(),
  quotedPriceCents: z.number().int(),
  actualPriceCents: z.number().int(),
  clientAccepted: z.boolean(),
  operatorResponseTimeSeconds: z.number().int().nonnegative(),
  aircraftSubstituted: z.boolean(),
  substitutionDetails: z.string().nullable(),
  reasonLost: ReasonLost.nullable(),
  dumontConfidenceAtQuote: z.number().min(0).max(1),
  priceErrorPct: z.number().nonnegative(),
  operatorName: z.string(),
  aircraftClass: z.string(),
  routeOrigin: z.string().length(4),                // ICAO
  routeDestination: z.string().length(4),            // ICAO
  leadTimeHours: z.number().nonnegative(),
  dayOfWeek: z.number().int().min(0).max(6),
  createdAt: z.string().datetime().optional(),
});

export type DealOutcomeRecord = z.infer<typeof DealOutcomeRecordSchema>;
