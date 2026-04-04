/**
 * Twilio conference bridge client — 3-way calls for voice copilot.
 * Per spec: communication-layer.md FR-5, section 2.3.
 * Credentials via env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN.
 */

/** Injectable fetch for testing. */
export type FetchFn = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

// ── Types ────────────────────────────────────────────────────────────────

export interface TwilioConference {
  conferenceSid: string;
  friendlyName: string;
  status: string;
}

export interface TwilioParticipant {
  callSid: string;
  label: string;
  muted: boolean;
}

export interface TwilioStreamConfig {
  streamSid: string;
  url: string;
}

export interface ParticipantOptions {
  label: string;
  muted?: boolean;
  announceUrl?: string;
}

// ── Client ───────────────────────────────────────────────────────────────

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  baseUrl?: string;
}

export class TwilioClient {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(config: TwilioConfig, fetchFn?: FetchFn) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.baseUrl = config.baseUrl ?? `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}`;
    this.fetchFn = fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`;
  }

  /**
   * Create a Twilio conference bridge with recording enabled.
   * @param dealId - Deal ID used as the conference friendly name.
   * @returns Conference SID and metadata.
   */
  async createConference(dealId: string): Promise<TwilioConference> {
    const url = `${this.baseUrl}/Conferences.json`;
    const resp = await this.fetchFn(url, {
      method: "POST",
      headers: { "Authorization": this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `FriendlyName=${encodeURIComponent(dealId)}&Record=true&RecordingChannels=dual`,
    });
    const data = await resp.json() as Record<string, unknown>;
    return {
      conferenceSid: String(data["sid"] ?? ""),
      friendlyName: dealId,
      status: String(data["status"] ?? "init"),
    };
  }

  /**
   * Add a participant to an existing conference.
   * @param conferenceSid - The conference to join.
   * @param phone - Phone number to dial.
   * @param options - Label, muted flag, consent disclosure URL.
   * @returns Participant call SID and metadata.
   */
  async addParticipant(conferenceSid: string, phone: string, options: ParticipantOptions): Promise<TwilioParticipant> {
    const url = `${this.baseUrl}/Conferences/${conferenceSid}/Participants.json`;
    let body = `To=${encodeURIComponent(phone)}&Label=${encodeURIComponent(options.label)}`;
    if (options.muted) body += "&Muted=true";
    if (options.announceUrl) body += `&AnnounceUrl=${encodeURIComponent(options.announceUrl)}`;

    const resp = await this.fetchFn(url, {
      method: "POST",
      headers: { "Authorization": this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await resp.json() as Record<string, unknown>;
    return {
      callSid: String(data["call_sid"] ?? ""),
      label: options.label,
      muted: options.muted ?? false,
    };
  }

  /**
   * Start a media stream from the conference to a WebSocket URL (for transcription).
   * @param conferenceSid - The conference to stream.
   * @param streamUrl - WebSocket URL to send audio to.
   * @returns Stream SID.
   */
  async startStream(conferenceSid: string, streamUrl: string): Promise<TwilioStreamConfig> {
    const url = `${this.baseUrl}/Conferences/${conferenceSid}/Streams.json`;
    const resp = await this.fetchFn(url, {
      method: "POST",
      headers: { "Authorization": this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: `Url=${encodeURIComponent(streamUrl)}&Track=both_tracks`,
    });
    const data = await resp.json() as Record<string, unknown>;
    return { streamSid: String(data["sid"] ?? ""), url: streamUrl };
  }

  /**
   * End a conference and all participants.
   * @param conferenceSid - The conference to terminate.
   */
  async endConference(conferenceSid: string): Promise<void> {
    const url = `${this.baseUrl}/Conferences/${conferenceSid}.json`;
    await this.fetchFn(url, {
      method: "POST",
      headers: { "Authorization": this.authHeader(), "Content-Type": "application/x-www-form-urlencoded" },
      body: "Status=completed",
    });
  }
}
