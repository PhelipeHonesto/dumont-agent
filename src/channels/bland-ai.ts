/**
 * Bland AI Channel Adapter — voice SDR + iMessage + SMS.
 * Handles TWO webhook types: voice call completed, SMS/iMessage inbound.
 * Delivers outbound via Bland AI send API (blue bubble iMessage + SMS fallback).
 *
 * Per spec: communication-layer.md Sprint 2, FR-1, FR-3.
 */

import type { Message, MessageChannel } from "../schemas/message.js";
import { generateMessageId } from "../schemas/message.js";
import type { ChannelAdapter, DeliveryResult } from "./adapter.js";
import type { BlandAiClient, BlandVoiceWebhook, BlandSmsWebhook } from "../integrations/bland-ai.js";

// ── Type Guards ──────────────────────────────────────────────────────────

function isVoiceWebhook(payload: unknown): payload is BlandVoiceWebhook {
  return typeof payload === "object" && payload !== null && (payload as Record<string, unknown>)["call_type"] === "voice";
}

function isSmsWebhook(payload: unknown): payload is BlandSmsWebhook {
  const p = payload as Record<string, unknown>;
  return typeof p === "object" && p !== null && (p["message_type"] === "sms" || p["message_type"] === "imessage");
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class BlandAiAdapter implements ChannelAdapter {
  readonly channel: MessageChannel = "bland_voice"; // overridden per webhook type
  private readonly client: BlandAiClient;

  constructor(client: BlandAiClient) {
    this.client = client;
  }

  /**
   * Normalize a Bland AI webhook payload into a Message.
   * Handles voice call completed and SMS/iMessage webhooks.
   * @param rawPayload - The parsed webhook JSON body.
   * @returns Normalized Message.
   * @throws If the payload is neither a voice nor SMS webhook.
   */
  receive(rawPayload: unknown): Message {
    if (isVoiceWebhook(rawPayload)) {
      return this.receiveVoice(rawPayload);
    }
    if (isSmsWebhook(rawPayload)) {
      return this.receiveSms(rawPayload);
    }
    throw new Error("Unknown Bland AI webhook type. Expected call_type='voice' or message_type='sms'|'imessage'.");
  }

  /**
   * Deliver an outbound message via Bland AI send API.
   * @param message - The message to send (must have message.to as phone number).
   * @returns Delivery result.
   */
  async deliver(message: Message): Promise<DeliveryResult> {
    if (!message.to) {
      return { success: false, platformMessageId: null, error: "No recipient phone number." };
    }

    const result = await this.client.sendMessage(message.to, message.body);
    return {
      success: result.success,
      platformMessageId: result.messageId,
      error: result.error,
    };
  }

  /** Bland AI webhooks are not real-time streaming. */
  supportsRealtime(): boolean {
    return false;
  }

  // ── Voice webhook ──────────────────────────────────────────────────

  private receiveVoice(payload: BlandVoiceWebhook): Message {
    const analysis = payload.analysis ?? {};
    const body = payload.summary ?? payload.transcript ?? "";

    // Map analysis fields to parsedData — same structure intake.ts extracts
    const parsedData: Record<string, unknown> = {};
    if (analysis.departure) parsedData["departure"] = analysis.departure;
    if (analysis.arrival) parsedData["arrival"] = analysis.arrival;
    if (analysis.date) parsedData["date"] = analysis.date;
    if (analysis.pax) parsedData["pax"] = analysis.pax;
    if (analysis.client_name) parsedData["clientName"] = analysis.client_name;
    if (analysis.client_phone) parsedData["clientPhone"] = analysis.client_phone;
    if (analysis.callback_preference) parsedData["callbackPreference"] = analysis.callback_preference;
    if (analysis.budget_min != null || analysis.budget_max != null) {
      parsedData["budget"] = {
        min: analysis.budget_min ?? 0,
        max: analysis.budget_max ?? 0,
      };
    }

    return {
      id: generateMessageId(),
      dealId: null,
      channel: "bland_voice",
      direction: "inbound",
      from: payload.from,
      to: payload.to,
      fromName: analysis.client_name ?? null,
      subject: null,
      body,
      bodyHtml: null,
      attachments: [],
      draftedBy: null,
      approvedBy: null,
      editDistance: null,
      originalDraft: null,
      receivedAt: payload.ended_at ?? new Date().toISOString(),
      draftedAt: null,
      approvedAt: null,
      sentAt: null,
      responseToId: null,
      responseTimeMs: null,
      threadId: payload.call_id,
      intent: null,
      parsedData: Object.keys(parsedData).length > 0 ? parsedData : null,
      confidence: null,
      confidenceLevel: null,
      platformMessageId: payload.call_id,
      platformMetadata: {
        callDuration: payload.duration,
        recordingUrl: payload.recording_url ?? null,
        callStatus: payload.status,
      },
    };
  }

  // ── SMS/iMessage webhook ───────────────────────────────────────────

  private receiveSms(payload: BlandSmsWebhook): Message {
    const attachments = (payload.media_urls ?? []).map((url) => ({
      url,
      mimeType: "application/octet-stream",
      filename: null,
      sizeBytes: null,
    }));

    return {
      id: generateMessageId(),
      dealId: null,
      channel: "bland_text",
      direction: "inbound",
      from: payload.from,
      to: payload.to,
      fromName: null,
      subject: null,
      body: payload.body,
      bodyHtml: null,
      attachments,
      draftedBy: null,
      approvedBy: null,
      editDistance: null,
      originalDraft: null,
      receivedAt: payload.received_at ?? new Date().toISOString(),
      draftedAt: null,
      approvedAt: null,
      sentAt: null,
      responseToId: null,
      responseTimeMs: null,
      threadId: null,
      intent: null,
      parsedData: null,
      confidence: null,
      confidenceLevel: null,
      platformMessageId: payload.message_id,
      platformMetadata: {
        messageType: payload.message_type,
      },
    };
  }
}
