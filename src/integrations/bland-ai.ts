/**
 * Bland AI API client — voice SDR, iMessage, and SMS.
 * Blue bubble iMessage with automatic SMS fallback.
 *
 * Per spec: communication-layer.md Sprint 2.
 * All credentials via env vars: BLAND_API_KEY, BLAND_WEBHOOK_SECRET.
 */

import { createHmac } from "node:crypto";

/** Fetch function type — injectable for testing. */
export type FetchFn = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

// ── Webhook payload types ────────────────────────────────────────────────

/** Structured analysis fields extracted by Bland AI voice agent. */
export interface BlandVoiceAnalysis {
  departure?: string;
  arrival?: string;
  date?: string;
  pax?: number;
  budget_min?: number;
  budget_max?: number;
  client_name?: string;
  client_phone?: string;
  callback_preference?: string;
  [key: string]: unknown;
}

/** Bland AI voice call completed webhook payload. */
export interface BlandVoiceWebhook {
  call_id: string;
  call_type: "voice";
  from: string;
  to: string;
  status: string;
  started_at: string;
  ended_at: string;
  duration: number;
  transcript: string;
  summary?: string;
  analysis?: BlandVoiceAnalysis;
  recording_url?: string;
}

/** Bland AI SMS/iMessage webhook payload. */
export interface BlandSmsWebhook {
  message_id: string;
  message_type: "sms" | "imessage";
  from: string;
  to: string;
  body: string;
  media_urls?: string[];
  received_at: string;
}

/** Options for sending via Bland AI. */
export interface BlandSendOptions {
  /** Force SMS even if iMessage is available. */
  forceSms?: boolean;
}

export interface BlandSendResult {
  success: boolean;
  messageId: string | null;
  error: string | null;
}

// ── API Client ───────────────────────────────────────────────────────────

export interface BlandAiConfig {
  apiKey: string;
  webhookSecret?: string;
  baseUrl?: string;
  phoneNumber?: string;
}

export class BlandAiClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string | null;
  private readonly fetchFn: FetchFn;
  readonly phoneNumber: string | null;

  constructor(config: BlandAiConfig, fetchFn?: FetchFn) {
    this.apiKey = config.apiKey;
    this.webhookSecret = config.webhookSecret ?? null;
    this.baseUrl = config.baseUrl ?? "https://api.bland.ai/v1";
    this.phoneNumber = config.phoneNumber ?? null;
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  /**
   * Send an iMessage/SMS via Bland AI.
   * Blue bubble iMessage with automatic SMS fallback for Android.
   * @param to - Recipient phone number.
   * @param body - Message text.
   * @param options - Send options (forceSms, etc.).
   * @returns Send result with platform message ID.
   */
  async sendMessage(to: string, body: string, options?: BlandSendOptions): Promise<BlandSendResult> {
    const url = `${this.baseUrl}/messages/send`;
    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to,
          from: this.phoneNumber,
          body,
          force_sms: options?.forceSms ?? false,
        }),
      });

      if (!resp.ok) {
        return { success: false, messageId: null, error: `API returned ${resp.status}` };
      }

      const data = await resp.json() as Record<string, unknown>;
      return {
        success: true,
        messageId: (data["message_id"] as string) ?? null,
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
   * Verify a webhook signature from Bland AI.
   * Uses HMAC-SHA256 of the raw payload body against the webhook secret.
   * @param payload - Raw payload string (JSON body).
   * @param signature - The signature from the X-Bland-Signature header.
   * @returns True if the signature is valid.
   */
  verifyWebhook(payload: string, signature: string): boolean {
    if (!this.webhookSecret) {
      console.warn("[security] Bland AI webhook secret not configured — rejecting unverified request");
      return false;
    }
    const expected = createHmac("sha256", this.webhookSecret)
      .update(payload)
      .digest("hex");
    return expected === signature;
  }
}
