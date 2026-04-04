/**
 * Conversation schema — unified thread for all messages in a deal.
 * Per spec: communication-layer.md FR-7 (Conversation Threading).
 */

import { z } from "zod";
import { MessageSchema, MessageChannel } from "./message.js";

export const AwaitingResponseFrom = z.enum(["client", "operator", "internal"]);
export type AwaitingResponseFrom = z.infer<typeof AwaitingResponseFrom>;

export const ConversationSchema = z.object({
  dealId: z.string(),
  messages: z.array(MessageSchema),
  touchpointCount: z.number().int().nonnegative(),
  avgResponseTimeMs: z.number().nonnegative().nullable(),
  channelsUsed: z.array(MessageChannel),
  clientContact: z.string().nullable(),
  operatorContact: z.string().nullable(),
  lastActivity: z.string().datetime().nullable(),
  awaitingResponseFrom: AwaitingResponseFrom.nullable(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/** Create an empty conversation for a deal. */
export function createConversation(dealId: string): Conversation {
  return {
    dealId,
    messages: [],
    touchpointCount: 0,
    avgResponseTimeMs: null,
    channelsUsed: [],
    clientContact: null,
    operatorContact: null,
    lastActivity: null,
    awaitingResponseFrom: null,
  };
}

/** Add a message to a conversation, updating metrics. */
export function addMessageToConversation(
  conv: Conversation,
  msg: z.infer<typeof MessageSchema>,
): void {
  conv.messages.push(msg);
  conv.touchpointCount = conv.messages.length;
  conv.lastActivity = msg.receivedAt ?? msg.sentAt ?? new Date().toISOString();

  // Track channels used
  if (!conv.channelsUsed.includes(msg.channel)) {
    conv.channelsUsed.push(msg.channel);
  }

  // Compute avg response time from inbound/outbound pairs
  const responseTimes = conv.messages
    .filter((m) => m.responseTimeMs !== null && m.responseTimeMs !== undefined)
    .map((m) => m.responseTimeMs!);
  if (responseTimes.length > 0) {
    conv.avgResponseTimeMs = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
  }
}
