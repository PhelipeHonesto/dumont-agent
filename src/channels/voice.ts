/**
 * Voice Copilot Channel Adapter — Twilio conference + Deepgram transcription.
 * Dumont listens while the broker negotiates. Extracts entities in real-time.
 * Per spec: communication-layer.md FR-5, section 2.3.
 */

import type { Message, MessageChannel } from "../schemas/message.js";
import { generateMessageId } from "../schemas/message.js";
import type { ChannelAdapter, DeliveryResult } from "./adapter.js";
import type { Call } from "../schemas/call.js";
import type { DealContext } from "../schemas/deal-context.js";

// ── Call Brief ───────────────────────────────────────────────────────────

export interface CallBrief {
  dealId: string;
  route: string;
  date: string;
  pax: number;
  estimateRange: string;
  operatorName: string;
  talkingPoints: string[];
}

/**
 * Generate a call brief from DealContext.
 * Gives the broker context before dialing the operator.
 */
export function generateCallBrief(deal: DealContext): CallBrief {
  const points: string[] = [];
  if (deal.estimate.priceRange) {
    points.push(`Estimate: $${deal.estimate.priceRange.low.toLocaleString()}-$${deal.estimate.priceRange.high.toLocaleString()}`);
  }
  if (deal.client.budget) {
    points.push(`Client budget ceiling: $${deal.client.budget.max.toLocaleString()}`);
  }
  if (deal.trip.aircraftClass) {
    points.push(`Aircraft class: ${deal.trip.aircraftClass}`);
  }
  points.push(`Target margin: 8-10%`);

  return {
    dealId: deal.id,
    route: `${deal.trip.departure} → ${deal.trip.arrival}`,
    date: deal.trip.date,
    pax: deal.trip.pax,
    estimateRange: deal.estimate.priceRange
      ? `$${deal.estimate.priceRange.low.toLocaleString()}-$${deal.estimate.priceRange.high.toLocaleString()}`
      : "No estimate",
    operatorName: deal.sourcing.selectedOperator?.operatorName ?? "Unknown",
    talkingPoints: points,
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class VoiceCopilotAdapter implements ChannelAdapter {
  readonly channel: MessageChannel = "voice_copilot";

  /**
   * Convert post-call data into a Message.
   * Called after a call ends with the full transcript and summary.
   */
  receive(rawPayload: unknown): Message {
    const call = rawPayload as Call;
    const body = call.summary ?? call.transcript.map((c) => `[${c.speaker}] ${c.text}`).join("\n");

    return {
      id: generateMessageId(),
      dealId: call.dealId,
      channel: "voice_copilot",
      direction: "inbound",
      from: call.participants.find((p) => p.role === "operator")?.phone ?? "",
      to: call.participants.find((p) => p.role === "broker")?.phone ?? "",
      fromName: call.participants.find((p) => p.role === "operator")?.name ?? null,
      subject: null,
      body,
      bodyHtml: null,
      attachments: [],
      draftedBy: null,
      approvedBy: null,
      editDistance: null,
      originalDraft: null,
      receivedAt: call.endedAt ?? new Date().toISOString(),
      draftedAt: null,
      approvedAt: null,
      sentAt: null,
      responseToId: null,
      responseTimeMs: null,
      threadId: call.callId,
      intent: null,
      parsedData: {
        callDuration: call.durationSec,
        entityCount: call.detectedEntities.length,
        recordingUrl: call.recordingUrl,
      },
      confidence: null,
      confidenceLevel: null,
      platformMessageId: call.callId,
      platformMetadata: null,
    };
  }

  /** No-op. Voice copilot doesn't send messages — it listens. */
  async deliver(_message: Message): Promise<DeliveryResult> {
    return { success: true, platformMessageId: null, error: null };
  }

  /** Voice copilot supports real-time streaming (WebSocket transcription). */
  supportsRealtime(): boolean {
    return true;
  }
}
