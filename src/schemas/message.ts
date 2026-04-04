/**
 * Message schema — the unified object every channel adapter produces.
 * The orchestrator and router never know which channel a message came from.
 * Per spec: communication-layer.md FR-1 (Message Normalization).
 */

import { z } from "zod";

export const MessageChannel = z.enum([
  "bland_voice",
  "bland_text",
  "email",
  "web_form",
  "voice_copilot",
]);
export type MessageChannel = z.infer<typeof MessageChannel>;

export const MessageDirection = z.enum(["inbound", "outbound"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const MessageIntent = z.enum([
  "quote_request",
  "quote_response",
  "confirmation",
  "decline",
  "follow_up",
  "negotiation",
  "info_request",
  "availability_check",
  "general",
]);
export type MessageIntent = z.infer<typeof MessageIntent>;

export const ConfidenceLevel = z.enum(["high", "medium", "low", "never"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const AttachmentSchema = z.object({
  url: z.string(),
  mimeType: z.string(),
  filename: z.string().nullable(),
  sizeBytes: z.number().nonnegative().nullable(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  dealId: z.string().nullable(),

  channel: MessageChannel,
  direction: MessageDirection,

  from: z.string(),
  to: z.string().nullable(),
  fromName: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string(),
  bodyHtml: z.string().nullable(),
  attachments: z.array(AttachmentSchema),

  draftedBy: z.enum(["dumont", "human"]).nullable(),
  approvedBy: z.string().nullable(),
  editDistance: z.number().int().nonnegative().nullable(),
  originalDraft: z.string().nullable(),

  receivedAt: z.string().datetime().nullable(),
  draftedAt: z.string().datetime().nullable(),
  approvedAt: z.string().datetime().nullable(),
  sentAt: z.string().datetime().nullable(),

  responseToId: z.string().nullable(),
  responseTimeMs: z.number().nonnegative().nullable(),
  threadId: z.string().nullable(),

  intent: MessageIntent.nullable(),
  parsedData: z.record(z.unknown()).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  confidenceLevel: ConfidenceLevel.nullable(),

  platformMessageId: z.string().nullable(),
  platformMetadata: z.record(z.unknown()).nullable(),
});
export type Message = z.infer<typeof MessageSchema>;

/** Create a Message ID. */
export function generateMessageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `msg_${ts}_${rand}`;
}
