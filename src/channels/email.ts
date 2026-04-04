/**
 * Email Channel Adapter — Resend-based email for operator RFQs and client quotes.
 * Per spec: communication-layer.md Sprint 3, FR-1, FR-3.
 */

import type { Message, MessageChannel } from "../schemas/message.js";
import { generateMessageId } from "../schemas/message.js";
import type { ChannelAdapter, DeliveryResult } from "./adapter.js";
import type { ResendClient, ResendInboundWebhook } from "../integrations/resend.js";
import { renderTemplate } from "../templates/render.js";

// ── Adapter ──────────────────────────────────────────────────────────────

export class EmailAdapter implements ChannelAdapter {
  readonly channel: MessageChannel = "email";
  private readonly client: ResendClient;

  constructor(client: ResendClient) {
    this.client = client;
  }

  /**
   * Parse a Resend inbound email webhook into a Message.
   * Extracts threading headers (In-Reply-To, References) for thread matching.
   */
  receive(rawPayload: unknown): Message {
    const payload = rawPayload as ResendInboundWebhook;
    const data = payload.data;
    const headers = data.headers ?? {};

    const inReplyTo = headers["In-Reply-To"] ?? headers["in-reply-to"] ?? null;
    const references = headers["References"] ?? headers["references"] ?? null;

    const attachments = (data.attachments ?? []).map((a) => ({
      url: a.url,
      mimeType: a.content_type,
      filename: a.filename,
      sizeBytes: null,
    }));

    return {
      id: generateMessageId(),
      dealId: null,
      channel: "email",
      direction: "inbound",
      from: data.from,
      to: data.to[0] ?? null,
      fromName: data.from_name ?? null,
      subject: data.subject,
      body: data.text ?? stripHtml(data.html ?? ""),
      bodyHtml: data.html ?? null,
      attachments,
      draftedBy: null,
      approvedBy: null,
      editDistance: null,
      originalDraft: null,
      receivedAt: data.created_at,
      draftedAt: null,
      approvedAt: null,
      sentAt: null,
      responseToId: inReplyTo,
      responseTimeMs: null,
      threadId: references ?? inReplyTo ?? null,
      intent: null,
      parsedData: null,
      confidence: null,
      confidenceLevel: null,
      platformMessageId: data.id,
      platformMetadata: null,
    };
  }

  /**
   * Send an outbound email via Resend with OSA-branded template.
   * Template is selected based on message intent.
   * Sets In-Reply-To header for threading if responseToId is present.
   */
  async deliver(message: Message): Promise<DeliveryResult> {
    if (!message.to) {
      return { success: false, platformMessageId: null, error: "No recipient email address." };
    }

    const html = this.renderForIntent(message);
    const headers: Record<string, string> = {};
    if (message.responseToId) {
      headers["In-Reply-To"] = message.responseToId;
      headers["References"] = message.responseToId;
    }

    const result = await this.client.sendEmail(
      message.to,
      message.subject ?? "OSA Connect",
      html,
      { headers: Object.keys(headers).length > 0 ? headers : undefined },
    );

    return {
      success: result.success,
      platformMessageId: result.messageId,
      error: result.error,
    };
  }

  supportsRealtime(): boolean {
    return false;
  }

  // ── Template selection ─────────────────────────────────────────────

  private renderForIntent(message: Message): string {
    const data = (message.parsedData ?? {}) as Record<string, string | number>;
    const templateData: Record<string, string | number> = {
      ...data,
      body: message.body,
      recipientName: String(data["recipientName"] ?? ""),
    };

    switch (message.intent) {
      case "quote_request":
      case "availability_check":
        return renderTemplate("operator-rfq", templateData);
      case "quote_response":
        return renderTemplate("client-quote", templateData);
      case "confirmation":
        return renderTemplate("confirmation", templateData);
      default:
        return renderTemplate("follow-up", templateData);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Strip HTML tags to get plain text. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
