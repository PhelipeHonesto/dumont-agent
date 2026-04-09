/**
 * Resend API client — email send/receive for operator RFQs and client quotes.
 * Per spec: communication-layer.md Sprint 3.
 * Credentials via env: RESEND_API_KEY, RESEND_WEBHOOK_SECRET, RESEND_FROM_ADDRESS.
 */

import { createHmac } from "node:crypto";

/** Fetch function type — injectable for testing. */
export type FetchFn = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

// ── Types ────────────────────────────────────────────────────────────────

export interface ResendSendOptions {
  from?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content: string }>;
}

export interface ResendSendResult {
  success: boolean;
  messageId: string | null;
  error: string | null;
}

/** Resend inbound email webhook payload. */
export interface ResendInboundWebhook {
  type: "email.received";
  data: {
    id: string;
    from: string;
    from_name?: string;
    to: string[];
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    attachments?: Array<{ filename: string; content_type: string; url: string }>;
    created_at: string;
  };
}

// ── Client ───────────────────────────────────────────────────────────────

export interface ResendConfig {
  apiKey: string;
  webhookSecret?: string;
  fromAddress?: string;
  baseUrl?: string;
}

export class ResendClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string | null;
  readonly fromAddress: string;
  private readonly fetchFn: FetchFn;

  constructor(config: ResendConfig, fetchFn?: FetchFn) {
    this.apiKey = config.apiKey;
    this.webhookSecret = config.webhookSecret ?? null;
    this.fromAddress = config.fromAddress ?? "charter@osa.aero";
    this.baseUrl = config.baseUrl ?? "https://api.resend.com";
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  /**
   * Send an email via Resend API.
   * @param to - Recipient email address.
   * @param subject - Email subject line.
   * @param html - HTML body content.
   * @param options - Reply-to, headers (In-Reply-To), attachments.
   * @returns Send result with Resend message ID.
   */
  async sendEmail(
    to: string,
    subject: string,
    html: string,
    options?: ResendSendOptions,
  ): Promise<ResendSendResult> {
    const url = `${this.baseUrl}/emails`;
    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: options?.from ?? this.fromAddress,
          to: [to],
          subject,
          html,
          reply_to: options?.replyTo,
          headers: options?.headers,
          attachments: options?.attachments,
        }),
      });

      if (!resp.ok) {
        return { success: false, messageId: null, error: `Resend API returned ${resp.status}` };
      }

      const data = await resp.json() as Record<string, unknown>;
      return {
        success: true,
        messageId: (data["id"] as string) ?? null,
        error: null,
      };
    } catch (err) {
      return {
        success: false,
        messageId: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Verify a Resend webhook signature.
   * @param payload - Raw JSON body string.
   * @param signature - Value from svix-signature header.
   * @returns True if valid.
   */
  verifyWebhook(payload: string, signature: string): boolean {
    if (!this.webhookSecret) {
      console.warn("[security] Resend webhook secret not configured — rejecting unverified request");
      return false;
    }
    const expected = createHmac("sha256", this.webhookSecret)
      .update(payload)
      .digest("hex");
    return expected === signature;
  }
}
