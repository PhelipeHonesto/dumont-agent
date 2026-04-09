/**
 * Deepgram streaming transcription client — Nova-2 with diarization.
 * Per spec: communication-layer.md FR-5, Sprint 4.
 * Credentials via env: DEEPGRAM_API_KEY.
 */

// ── Aviation Vocabulary ──────────────────────────────────────────────────
// Seeded with known terms. Grows as more calls are processed.

export const AVIATION_VOCABULARY: string[] = [
  // ICAO airport codes
  "KTEB", "KPBI", "KASE", "KPWK", "KORD", "KMDW", "KMIA", "KFLL",
  "KVNY", "KLAS", "KDAL", "KHOU", "KHPN", "KEGE", "KLAX", "KJFK",
  "MYNN", "MMSD", "TXKF",
  // Aircraft types
  "Phenom 300E", "Phenom 300", "Citation CJ3", "Citation CJ3+",
  "Citation Latitude", "Citation X", "Citation X+",
  "Challenger 300", "Challenger 350", "Challenger 650",
  "Gulfstream G280", "Gulfstream G550", "Gulfstream G650",
  "Global 7500", "Global 6000", "Global Express",
  "King Air 350", "King Air 350i", "Learjet 75",
  // Pricing language
  "all-in", "plus fees", "repositioning", "empty leg",
  "twenty-eight five", "thirty-two thousand",
  "per hour", "block rate",
  // Aviation terms
  "Part 135", "ARGUS", "Wyvern", "FBO", "tail number",
];

// ── Types ────────────────────────────────────────────────────────────────

export interface DeepgramConfig {
  apiKey: string;
  model?: string;
  language?: string;
  customVocabulary?: string[];
}

/** Callback for each transcript chunk. */
export type TranscriptCallback = (chunk: {
  speaker: number;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  isFinal: boolean;
}) => void;

/** Injectable WebSocket factory for testing. No real connections in tests. */
export type WebSocketFactory = (url: string) => MockableWebSocket;

export interface MockableWebSocket {
  send(data: unknown): void;
  close(): void;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  readyState: number;
}

// ── Client ───────────────────────────────────────────────────────────────

export class DeepgramClient {
  readonly apiKey: string;
  private readonly model: string;
  private readonly language: string;
  private readonly vocabulary: string[];
  private readonly wsFactory: WebSocketFactory | null;
  private ws: MockableWebSocket | null = null;
  private callback: TranscriptCallback | null = null;

  constructor(config: DeepgramConfig, wsFactory?: WebSocketFactory) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "nova-2";
    this.language = config.language ?? "en";
    this.vocabulary = [...AVIATION_VOCABULARY, ...(config.customVocabulary ?? [])];
    this.wsFactory = wsFactory ?? null;
  }

  /**
   * Open a streaming transcription session with Deepgram.
   * Uses Nova-2 with diarization and custom aviation vocabulary.
   * @returns The session config for reference.
   */
  createStreamingSession(): { model: string; language: string; vocabularySize: number } {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      diarize: "true",
      punctuate: "true",
      interim_results: "true",
      keywords: this.vocabulary.slice(0, 100).join(","),
    });

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    if (this.wsFactory) {
      this.ws = this.wsFactory(url);
      this.ws.onmessage = (event) => this.handleMessage(event.data);
    }

    return { model: this.model, language: this.language, vocabularySize: this.vocabulary.length };
  }

  /**
   * Register a callback for transcript chunks.
   * @param cb - Called on each transcript chunk with speaker, text, timing, confidence.
   */
  onTranscript(cb: TranscriptCallback): void {
    this.callback = cb;
  }

  /** Send raw audio data to the Deepgram session. */
  sendAudio(data: unknown): void {
    this.ws?.send(data);
  }

  /** Close the streaming session. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  /** Parse a Deepgram WebSocket message and fire the callback. */
  private handleMessage(raw: string): void {
    if (!this.callback) return;
    try {
      const msg = JSON.parse(raw) as DeepgramResponse;
      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      this.callback({
        speaker: msg.channel?.alternatives?.[0]?.words?.[0]?.speaker ?? 0,
        text: alt.transcript,
        startMs: Math.round((msg.start ?? 0) * 1000),
        endMs: Math.round(((msg.start ?? 0) + (msg.duration ?? 0)) * 1000),
        confidence: alt.confidence ?? 0,
        isFinal: msg.is_final ?? false,
      });
    } catch (err) {
      console.warn(`[deepgram:onMessage] Malformed WebSocket message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Deepgram response shape (subset) ─────────────────────────────────────

interface DeepgramResponse {
  channel?: {
    alternatives?: Array<{
      transcript: string;
      confidence: number;
      words?: Array<{ speaker: number }>;
    }>;
  };
  start?: number;
  duration?: number;
  is_final?: boolean;
}
