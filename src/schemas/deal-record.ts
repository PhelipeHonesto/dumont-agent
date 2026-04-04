/**
 * Deal Record — the shape stored in the learning loop memory.
 * One record per completed deal. Feeds pricing, operator, and client intelligence.
 *
 * Per spec: learning-loop.md
 */

import { z } from "zod";
import { ClientType, DealMode } from "./deal-context.js";

export const DealRecordOutcome = z.enum([
  "closed",
  "lost_to_competition",
  "client_declined",
  "budget_mismatch",
  "aircraft_unavailable",
  "operator_no_response",
  "expired",
]);

export const Season = z.enum(["peak", "shoulder", "off"]);

export const DealRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  mode: DealMode,

  // Route
  route: z.object({
    departure: z.string().length(4),
    arrival: z.string().length(4),
    distance: z.number().nonnegative(),
  }),

  // Pricing
  aviapagesEstimate: z.object({ low: z.number(), high: z.number() }).nullable(),
  operatorQuote: z.number().nullable(),
  osaPrice: z.number().nullable(),
  estimateDelta: z.number().nullable(),

  // Operator
  operatorName: z.string().nullable(),
  operatorBase: z.string().nullable(),
  operatorResponseTime: z.number().nullable(),
  operatorConversion: z.boolean(),

  // Aircraft
  aircraftType: z.string().nullable(),
  aircraftClass: z.string().nullable(),

  // Client
  clientName: z.string().nullable(),
  clientContact: z.string().nullable(),
  clientType: ClientType,
  clientBudget: z.object({ min: z.number(), max: z.number() }).nullable(),
  clientConversion: z.boolean(),
  decisionTime: z.number().nullable(),

  // Outcome
  result: DealRecordOutcome,
  revenue: z.number().nullable(),
  margin: z.number().nullable(),

  // Timing
  totalDealTime: z.number().nullable(),
  dayOfWeek: z.number().int().min(0).max(6),
  season: Season,

  // Meta
  guardianFlags: z.array(z.string()),
});

export type DealRecord = z.infer<typeof DealRecordSchema>;
