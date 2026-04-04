/**
 * Transcript Processor — real-time entity extraction from voice calls.
 * Runs on each transcript chunk AND post-call on the full transcript.
 * Per spec: communication-layer.md FR-5, Sprint 4.
 */

import type { TranscriptChunk, DetectedEntity } from "../schemas/call.js";
import { AVIATION_VOCABULARY } from "../integrations/deepgram.js";

// ── Known aircraft types for detection ───────────────────────────────────

const AIRCRAFT_TYPES = new Set(
  AVIATION_VOCABULARY.filter((v) =>
    /^(phenom|citation|challenger|gulfstream|global|king air|learjet)/i.test(v),
  ).map((v) => v.toLowerCase()),
);

const ICAO_CODES = new Set(
  AVIATION_VOCABULARY.filter((v) => /^[A-Z]{4}$/.test(v)),
);

// ── Phonetic tail number mapping ─────────────────────────────────────────

const PHONETIC: Record<string, string> = {
  alpha: "A", bravo: "B", charlie: "C", delta: "D", echo: "E",
  foxtrot: "F", golf: "G", hotel: "H", india: "I", juliet: "J",
  kilo: "K", lima: "L", mike: "M", november: "N", oscar: "O",
  papa: "P", quebec: "Q", romeo: "R", sierra: "S", tango: "T",
  uniform: "U", victor: "V", whiskey: "W", xray: "X", yankee: "Y", zulu: "Z",
};

const SPOKEN_NUMBERS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  niner: "9", hundred: "00",
};

// ── Price patterns (shared logic with message-router extractPrice) ───────

/**
 * Extract a dollar amount from text.
 * Supports: "$28,000", "$28k", "28 thousand", "twenty-eight five" (= $28,500).
 */
export function extractPrice(text: string): number | null {
  const lower = text.toLowerCase();

  // "$XXk"
  const kMatch = lower.match(/\$\s*(\d+)\s*k\b/);
  if (kMatch) return parseInt(kMatch[1]!, 10) * 1000;

  // "XX thousand"
  const thousandMatch = lower.match(/(\d+)\s*thousand/);
  if (thousandMatch) return parseInt(thousandMatch[1]!, 10) * 1000;

  // "$XX,XXX" or "$XXXXX"
  const dollarMatch = lower.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (dollarMatch) {
    const val = parseFloat(dollarMatch[1]!.replace(/,/g, ""));
    if (val > 100) return val;
  }

  // Spoken: "twenty-eight five" = $28,500
  const spokenMatch = lower.match(/(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-](?:one|two|three|four|five|six|seven|eight|nine)\s*(?:five|hundred)?/);
  if (spokenMatch) {
    const parsed = parseSpokenPrice(spokenMatch[0]);
    if (parsed) return parsed;
  }

  return null;
}

function parseSpokenPrice(spoken: string): number | null {
  const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const ones: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const parts = spoken.toLowerCase().replace(/-/g, " ").split(/\s+/);
  if (parts.length < 2) return null;
  const t = tens[parts[0]!];
  const o = ones[parts[1]!];
  if (t == null || o == null) return null;
  const base = t + o;
  // "twenty-eight five" = $28,500. "twenty-eight hundred" = $2,800
  if (parts[2] === "five") return base * 1000 + 500;
  if (parts[2] === "hundred") return base * 100;
  return base * 1000;
}

// ── Entity Detection ─────────────────────────────────────────────────────

/**
 * Process a single transcript chunk for entity detection.
 * Runs in real-time during the call.
 *
 * @param chunk - The transcript chunk to analyze.
 * @param _accumulated - All previous chunks (for context). Unused in v1.
 * @returns Array of newly detected entities.
 */
export function processChunk(
  chunk: TranscriptChunk,
  _accumulated: TranscriptChunk[] = [],
): DetectedEntity[] {
  return detectEntities(chunk.text, chunk.speaker, chunk.timestampMs, chunk.confidence);
}

/**
 * Post-call batch extraction from the full transcript.
 * More thorough than real-time because it has full context.
 *
 * @param chunks - All transcript chunks from the call.
 * @returns All detected entities across the full transcript.
 */
export function extractAllEntities(chunks: TranscriptChunk[]): DetectedEntity[] {
  const all: DetectedEntity[] = [];
  const fullText = chunks.map((c) => c.text).join(" ");

  // Run per-chunk detection
  for (const chunk of chunks) {
    all.push(...processChunk(chunk));
  }

  // Also run on concatenated text for cross-chunk patterns
  const crossChunk = detectEntities(fullText, "unknown", 0, 0.8);
  // Deduplicate by value
  const seen = new Set(all.map((e) => `${e.type}:${e.value}`));
  for (const e of crossChunk) {
    const key = `${e.type}:${e.value}`;
    if (!seen.has(key)) {
      all.push(e);
      seen.add(key);
    }
  }

  return all;
}

function detectEntities(
  text: string,
  speaker: string,
  timestampMs: number,
  baseConfidence: number,
): DetectedEntity[] {
  const entities: DetectedEntity[] = [];
  const speakerLabel = speaker === "broker" || speaker === "counterparty" || speaker === "unknown"
    ? speaker
    : (speaker === "0" || speaker === 0 as unknown as string ? "broker" : "counterparty");

  // Price
  const price = extractPrice(text);
  if (price) {
    entities.push({
      type: "price",
      value: `$${price.toLocaleString()}`,
      raw: text.match(/\$[\d,k]+|\d+\s*(?:thousand|k\b)|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]\w+/i)?.[0] ?? text,
      speaker: speakerLabel,
      confidence: baseConfidence,
      timestampMs,
    });
  }

  // Aircraft type
  const lower = text.toLowerCase();
  for (const acType of AIRCRAFT_TYPES) {
    if (lower.includes(acType)) {
      entities.push({
        type: "aircraft_type",
        value: acType.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
        raw: acType,
        speaker: speakerLabel,
        confidence: baseConfidence,
        timestampMs,
      });
      break;
    }
  }

  // Airport ICAO codes
  for (const icao of ICAO_CODES) {
    if (text.includes(icao)) {
      entities.push({
        type: "airport",
        value: icao,
        raw: icao,
        speaker: speakerLabel,
        confidence: baseConfidence,
        timestampMs,
      });
    }
  }

  // Tail number: "november three hundred echo lima" → N300EL, or direct "N300EL"
  const tailDirect = text.match(/\bN\d{1,5}[A-Z]{0,2}\b/);
  if (tailDirect) {
    entities.push({ type: "tail_number", value: tailDirect[0], raw: tailDirect[0], speaker: speakerLabel, confidence: baseConfidence, timestampMs });
  } else {
    const tailParsed = parsePhoneticTail(text);
    if (tailParsed) {
      entities.push({ type: "tail_number", value: tailParsed, raw: text, speaker: speakerLabel, confidence: baseConfidence * 0.8, timestampMs });
    }
  }

  // Availability
  if (/\b(?:not available|unavailable|sold|booked out)\b/i.test(text)) {
    entities.push({ type: "availability", value: "false", raw: text.match(/not available|unavailable|sold|booked out/i)?.[0] ?? "", speaker: speakerLabel, confidence: baseConfidence, timestampMs });
  } else if (/\b(?:(?:is |it's )?available|can do|can confirm)\b/i.test(text)) {
    entities.push({ type: "availability", value: "true", raw: text.match(/available|can do|can confirm/i)?.[0] ?? "", speaker: speakerLabel, confidence: baseConfidence, timestampMs });
  }

  // Hold duration
  const holdMatch = text.match(/hold\s+(?:it\s+)?(?:for\s+)?(\w+)\s*(hours?|minutes?|min)/i);
  if (holdMatch) {
    const num = SPOKEN_NUMBERS[holdMatch[1]!.toLowerCase()] ?? holdMatch[1]!;
    const unit = holdMatch[2]!.startsWith("h") ? 60 : 1;
    entities.push({ type: "hold_duration", value: `${parseInt(num, 10) * unit}min`, raw: holdMatch[0], speaker: speakerLabel, confidence: baseConfidence, timestampMs });
  }

  // Negotiation signals
  if (/\b(?:best I can do|firm|final offer|take it or leave)\b/i.test(text)) {
    entities.push({ type: "negotiation_signal", value: "firm", raw: text.match(/best I can do|firm|final offer/i)?.[0] ?? "", speaker: speakerLabel, confidence: baseConfidence, timestampMs });
  } else if (/\b(?:I (?:might|could|can) (?:be able to|do)|maybe|possibly|let me see)\b/i.test(text)) {
    entities.push({ type: "negotiation_signal", value: "flexible", raw: text.match(/might be able|could do|can do|maybe|possibly/i)?.[0] ?? "", speaker: speakerLabel, confidence: baseConfidence, timestampMs });
  } else if (/\b(?:let me check|give me a (?:minute|moment|sec)|hold on)\b/i.test(text)) {
    entities.push({ type: "negotiation_signal", value: "checking", raw: text.match(/let me check|give me a/i)?.[0] ?? "", speaker: speakerLabel, confidence: baseConfidence, timestampMs });
  }

  return entities;
}

// ── Phonetic tail number parser ──────────────────────────────────────────

function parsePhoneticTail(text: string): string | null {
  const words = text.toLowerCase().split(/\s+/);
  const novIdx = words.indexOf("november");
  if (novIdx < 0) return null;

  let tail = "N";
  for (let i = novIdx + 1; i < words.length && i < novIdx + 6; i++) {
    const w = words[i]!;
    if (PHONETIC[w]) tail += PHONETIC[w];
    else if (SPOKEN_NUMBERS[w]) tail += SPOKEN_NUMBERS[w];
    else if (/^\d$/.test(w)) tail += w;
    else break;
  }
  return tail.length >= 3 ? tail : null;
}

// ── Summary generation (post-call) ───────────────────────────────────────

export interface SummaryOptions {
  /** Injectable LLM call for testing. */
  summarize?: (transcript: string, entities: DetectedEntity[]) => Promise<string>;
}

/**
 * Generate a post-call summary from transcript + detected entities.
 * Uses Claude Haiku for summarization (or injectable mock).
 *
 * @param chunks - All transcript chunks.
 * @param entities - All detected entities.
 * @param options - Injectable summarizer for testing.
 * @returns Concise text summary.
 */
export async function generateSummary(
  chunks: TranscriptChunk[],
  entities: DetectedEntity[],
  options?: SummaryOptions,
): Promise<string> {
  const fullText = chunks.map((c) => `[${c.speaker}] ${c.text}`).join("\n");

  if (options?.summarize) {
    return options.summarize(fullText, entities);
  }

  // Default: build a structured summary without LLM
  const prices = entities.filter((e) => e.type === "price").map((e) => e.value);
  const aircraft = entities.filter((e) => e.type === "aircraft_type").map((e) => e.value);
  const availability = entities.find((e) => e.type === "availability");

  const parts: string[] = [];
  if (aircraft.length > 0) parts.push(`Aircraft discussed: ${aircraft.join(", ")}`);
  if (prices.length > 0) parts.push(`Prices mentioned: ${prices.join(", ")}`);
  if (availability) parts.push(`Availability: ${availability.value === "true" ? "confirmed" : "not available"}`);
  parts.push(`Duration: ${chunks.length} transcript segments`);

  return parts.join(". ") + ".";
}
