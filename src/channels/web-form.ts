/**
 * Web Form Channel Adapter — handles "Get a Quote" website submissions.
 * Inbound only. Always creates new deal. Responses go via email/SMS.
 * Per spec: communication-layer.md Sprint 3, FR-3.
 */

import type { Message, MessageChannel } from "../schemas/message.js";
import { generateMessageId } from "../schemas/message.js";
import type { ChannelAdapter, DeliveryResult } from "./adapter.js";

/** Expected form POST fields. */
export interface WebFormPayload {
  name: string;
  email: string;
  phone?: string;
  departure?: string;
  arrival?: string;
  date?: string;
  pax?: number | string;
  budget?: string;
  notes?: string;
}

export class WebFormAdapter implements ChannelAdapter {
  readonly channel: MessageChannel = "web_form";

  /**
   * Parse a website form POST body into a Message.
   * Maps structured form fields into both body (for intake parser) and parsedData.
   */
  receive(rawPayload: unknown): Message {
    const form = rawPayload as WebFormPayload;

    // Build body text from form fields for the intake parser
    const parts: string[] = [];
    if (form.departure && form.arrival) {
      parts.push(`Flight from ${form.departure} to ${form.arrival}`);
    }
    if (form.date) parts.push(`on ${form.date}`);
    if (form.pax) parts.push(`for ${form.pax} passengers`);
    if (form.budget) parts.push(`Budget: ${form.budget}`);
    if (form.notes) parts.push(form.notes);
    const body = (parts.join(". ") || `Quote request from ${form.name}`).slice(0, 2000);

    const parsedData: Record<string, unknown> = {};
    if (form.name) parsedData["clientName"] = form.name;
    if (form.email) parsedData["clientEmail"] = form.email;
    if (form.phone) parsedData["clientPhone"] = form.phone;
    if (form.departure) parsedData["departure"] = form.departure;
    if (form.arrival) parsedData["arrival"] = form.arrival;
    if (form.date) parsedData["date"] = form.date;
    if (form.pax) parsedData["pax"] = typeof form.pax === "string" ? parseInt(form.pax, 10) : form.pax;
    if (form.budget) parsedData["budget"] = form.budget;
    if (form.notes) parsedData["notes"] = form.notes;

    return {
      id: generateMessageId(),
      dealId: null,
      channel: "web_form",
      direction: "inbound",
      from: form.email,
      to: null,
      fromName: form.name,
      subject: null,
      body,
      bodyHtml: null,
      attachments: [],
      draftedBy: null,
      approvedBy: null,
      editDistance: null,
      originalDraft: null,
      receivedAt: new Date().toISOString(),
      draftedAt: null,
      approvedAt: null,
      sentAt: null,
      responseToId: null,
      responseTimeMs: null,
      threadId: null,
      intent: "quote_request",
      parsedData: Object.keys(parsedData).length > 0 ? parsedData : null,
      confidence: null,
      confidenceLevel: null,
      platformMessageId: null,
      platformMetadata: null,
    };
  }

  /**
   * No-op. Web form responses go via email or Bland AI text.
   */
  async deliver(_message: Message): Promise<DeliveryResult> {
    return { success: true, platformMessageId: null, error: null };
  }

  supportsRealtime(): boolean {
    return false;
  }
}
