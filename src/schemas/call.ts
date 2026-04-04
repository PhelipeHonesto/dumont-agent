/**
 * Call + TranscriptChunk schemas — voice pipeline data.
 * Per spec: communication-layer.md FR-5, section 2.3.
 */

import { z } from "zod";

export const DetectedEntityType = z.enum([
  "price",
  "aircraft_type",
  "tail_number",
  "airport",
  "date",
  "pax_count",
  "hold_duration",
  "availability",
  "negotiation_signal",
]);
export type DetectedEntityType = z.infer<typeof DetectedEntityType>;

export const DetectedEntitySchema = z.object({
  type: DetectedEntityType,
  value: z.string(),
  raw: z.string(),
  speaker: z.enum(["broker", "counterparty", "unknown"]),
  confidence: z.number().min(0).max(1),
  timestampMs: z.number().nonnegative(),
});
export type DetectedEntity = z.infer<typeof DetectedEntitySchema>;

export const TranscriptChunkSchema = z.object({
  chunkId: z.string(),
  speaker: z.enum(["broker", "counterparty", "unknown"]),
  text: z.string(),
  timestampMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  isFinal: z.boolean(),
  detectedEntities: z.array(DetectedEntitySchema),
});
export type TranscriptChunk = z.infer<typeof TranscriptChunkSchema>;

export const CallSchema = z.object({
  callId: z.string(),
  dealId: z.string(),
  direction: z.enum(["outbound_to_operator", "outbound_to_client", "inbound"]),
  participants: z.array(z.object({
    name: z.string(),
    role: z.enum(["broker", "operator", "client"]),
    phone: z.string(),
  })),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationSec: z.number().nonnegative().nullable(),
  transcript: z.array(TranscriptChunkSchema),
  detectedEntities: z.array(DetectedEntitySchema),
  summary: z.string().nullable(),
  recordingUrl: z.string().nullable(),
  recordingExpiresAt: z.string().datetime().nullable(),
});
export type Call = z.infer<typeof CallSchema>;
