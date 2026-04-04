/**
 * Intake Capability — parse raw client requests into structured trip data.
 * Qualifies the client before anything moves downstream.
 *
 * Per spec: capabilities/intake.md
 *
 * Architecture:
 * 1. Code layer: regex/pattern extraction for structured data
 * 2. LLM layer: Claude Sonnet via safeLlmCall for complex/ambiguous text
 * 3. Post-processing: ICAO resolution, date normalization
 * 4. Qualification: reject if no route/date/pax. Pause (don't fail) if no budget.
 * 5. Repeat client detection: query DealStore by name/contact
 *
 * Reference: ~/osa/simulator/src/agents/intake.ts (old parser)
 * Key changes:
 * - Outputs to flat DealContext client + trip (not TripBrief)
 * - Client qualification with budget gate
 * - Repeat client detection from DealStore memory
 * - Budget extraction from natural language
 */

import { z } from "zod";
import type { DealContext } from "../schemas/deal-context.js";
import { AircraftClass } from "../schemas/deal-context.js";
import type { IntakeResult } from "../orchestrator/index.js";
import type { DealStore } from "../memory/deal-store.js";
import { BUDGET_ESTIMATION } from "../config.js";

// ── Airport Resolution ───────────────────────────────────────────────────

/** City name → ICAO mapping for unambiguous private aviation airports. */
export const CITY_TO_ICAO: Record<string, string> = {
  // NYC metro
  teterboro: "KTEB", "new york": "KTEB", ny: "KTEB", nyc: "KTEB",
  "new york city": "KTEB", "nyc area": "KTEB",
  westchester: "KHPN", connecticut: "KHPN", ct: "KHPN",
  // Florida
  "palm beach": "KPBI", "west palm beach": "KPBI", "south florida": "KPBI",
  sofla: "KPBI", "so fla": "KPBI",
  miami: "KMIA", "fort lauderdale": "KFLL", "boca raton": "KBCT",
  // Chicago
  chicago: "KORD", midway: "KMDW", "chicago midway": "KMDW",
  "chicago executive": "KPWK", palwaukee: "KPWK",
  // Texas
  dallas: "KDAL", "dallas love field": "KDAL", "love field": "KDAL",
  houston: "KHOU", "houston hobby": "KHOU", hobby: "KHOU",
  // West coast
  "las vegas": "KLAS", vegas: "KLAS",
  "van nuys": "KVNY", "los angeles": "KVNY", la: "KVNY",
  // Mountain
  aspen: "KASE", vail: "KEGE", eagle: "KEGE",
  // International
  nassau: "MYNN", bahamas: "MYNN",
  bermuda: "TXKF",
  cabo: "MMSD", "cabo san lucas": "MMSD", "san jose del cabo": "MMSD",
};

/**
 * Resolve a city/airport reference to ICAO code.
 * Tries: direct ICAO match, city lookup, partial metro match.
 */
export function resolveIcao(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Already a valid ICAO code (4 uppercase letters)
  if (/^[A-Z]{4}$/.test(trimmed)) return trimmed;

  // Normalize for lookup
  const lower = trimmed.toLowerCase()
    .replace(/\s*airport\s*/g, "")
    .replace(/\s*international\s*/g, "")
    .replace(/\s*area\s*/g, "")
    .trim();

  // Direct city match
  if (CITY_TO_ICAO[lower]) return CITY_TO_ICAO[lower]!;

  // Partial match — only match multi-word keys or keys of 3+ chars to avoid
  // false positives (e.g. "la" matching inside "Atlantis").
  // Sort by key length descending so longer matches win.
  const sortedEntries = Object.entries(CITY_TO_ICAO)
    .filter(([city]) => city.length >= 3)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [city, icao] of sortedEntries) {
    // Check if the city name appears as a whole word in the input
    const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(lower)) return icao;
  }

  return null;
}

// ── Code-Layer Extraction ────────────────────────────────────────────────

const WORD_NUMS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

/** Extract passenger count from text. */
export function extractPax(text: string): number | null {
  const lower = text.toLowerCase();

  // "just me" / "just myself" → 1
  if (/\bjust\s+(?:me|myself)\b/.test(lower)) return 1;

  // "a couple" → 2, "a few" → 3
  if (/\ba\s+couple\b/.test(lower)) return 2;
  if (/\ba\s+few\b/.test(lower)) return 3;

  // Word numbers: "five passengers", "three of us", or standalone
  for (const [word, num] of Object.entries(WORD_NUMS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) return num;
  }

  // "N passengers" / "N pax" / "N people" / "N ppl"
  const paxMatch = lower.match(/(\d+)\s*(?:passengers?|pax|people|ppl|persons?|guests?|travelers?)/);
  if (paxMatch) return parseInt(paxMatch[1]!, 10);

  // "N of us" / "N of them"
  const ofUsMatch = lower.match(/(\d+)\s+of\s+(?:us|them)/);
  if (ofUsMatch) return parseInt(ofUsMatch[1]!, 10);

  // "party of N"
  const partyMatch = lower.match(/party\s+of\s+(\d+)/);
  if (partyMatch) return parseInt(partyMatch[1]!, 10);

  // "N couples" → N*2
  const couplesMatch = lower.match(/(\d+)\s*couples?/);
  if (couplesMatch) return parseInt(couplesMatch[1]!, 10) * 2;

  // "for N" at end of phrase about flying
  const forMatch = lower.match(/(?:fly|flight|charter|book).*?for\s+(\d+)/);
  if (forMatch) return parseInt(forMatch[1]!, 10);

  // "me and my wife" / "my wife and I" = 2
  if (/me\s+and\s+my\s+(?:wife|husband|partner|spouse)/i.test(lower) ||
      /my\s+(?:wife|husband|partner|spouse)\s+and\s+(?:me|i)/i.test(lower)) {
    // Check for "plus N kids" or "and N kids"
    const kidsMatch = lower.match(/(?:plus|and|\+)\s*(?:the\s+)?(?:(\d+)\s+)?kids?/);
    if (kidsMatch) {
      const kidCount = kidsMatch[1] ? parseInt(kidsMatch[1], 10) : 1;
      return 2 + kidCount;
    }
    return 2;
  }

  // Bare number at start or end: "4 from Teterboro" or "Teterboro to Miami 6"
  // Only if small enough to be pax count
  const bareStart = lower.match(/^(\d{1,2})\s+(?:from|leaving|departing|out\s+of)/);
  if (bareStart) {
    const n = parseInt(bareStart[1]!, 10);
    if (n >= 1 && n <= 19) return n;
  }

  return null;
}

/** Extract budget range from text. Returns {min, max} or null. */
export function extractBudget(text: string): { min: number; max: number } | null {
  const lower = text.toLowerCase();

  // "$XX,XXX - $YY,YYY" or "$XXk-$YYk"
  const rangeMatch = lower.match(/\$\s*([\d,]+(?:\.\d+)?)\s*k?\s*[-–to]+\s*\$?\s*([\d,]+(?:\.\d+)?)\s*k?/);
  if (rangeMatch) {
    let low = parseFloat(rangeMatch[1]!.replace(/,/g, ""));
    let high = parseFloat(rangeMatch[2]!.replace(/,/g, ""));
    // If "k" suffix or values < 1000, multiply by 1000
    if (lower.includes("k") || low < 1000) { low *= 1000; high *= 1000; }
    return { min: Math.min(low, high), max: Math.max(low, high) };
  }

  // "budget of $XX,XXX" / "around $XXk" / "about $XX,XXX"
  const singleMatch = lower.match(/(?:budget|spend|around|about|roughly|approximately|up\s+to|max(?:imum)?|no\s+more\s+than)\s+\$?\s*([\d,]+(?:\.\d+)?)\s*k?/);
  if (singleMatch) {
    let amount = parseFloat(singleMatch[1]!.replace(/,/g, ""));
    if (lower.includes("k") || amount < 1000) amount *= 1000;
    // "up to" / "max" / "no more than" → treat as ceiling
    if (/up\s+to|max|no\s+more/i.test(lower)) {
      return { min: 0, max: amount };
    }
    // "around" / "about" → ±15%
    return { min: Math.round(amount * BUDGET_ESTIMATION.lowMultiplier), max: Math.round(amount * BUDGET_ESTIMATION.highMultiplier) };
  }

  // Bare "$XX,XXX" — single dollar amount
  const bareAmount = lower.match(/\$\s*([\d,]+(?:\.\d+)?)\s*k?\b/);
  if (bareAmount) {
    let amount = parseFloat(bareAmount[1]!.replace(/,/g, ""));
    if (amount < 1000) amount *= 1000;
    return { min: Math.round(amount * BUDGET_ESTIMATION.lowMultiplier), max: Math.round(amount * BUDGET_ESTIMATION.highMultiplier) };
  }

  return null;
}

/** Extract ISO date from text. */
export function extractDate(text: string, today: Date = new Date()): string | null {
  // ISO date already present
  const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1]!;

  // "Month DD" or "Month DD, YYYY"
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
    jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  const monthDayMatch = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i);
  if (monthDayMatch) {
    const month = months[monthDayMatch[1]!.toLowerCase()];
    const day = parseInt(monthDayMatch[2]!, 10);
    const year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : today.getFullYear();
    if (month !== undefined) {
      const d = new Date(year, month, day);
      return formatDateLocal(d);
    }
  }

  // "MM/DD/YYYY" or "MM/DD"
  const slashMatch = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashMatch) {
    const month = parseInt(slashMatch[1]!, 10) - 1;
    const day = parseInt(slashMatch[2]!, 10);
    let year = slashMatch[3] ? parseInt(slashMatch[3], 10) : today.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    return formatDateLocal(d);
  }

  // Relative: "next Monday", "this Friday", etc.
  const days: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };

  const relMatch = text.match(/\b(next|this|coming)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i);
  if (relMatch) {
    const qualifier = relMatch[1]!.toLowerCase();
    const targetDay = days[relMatch[2]!.toLowerCase()]!;
    const todayDay = today.getDay();
    let daysAhead = targetDay - todayDay;
    if (daysAhead <= 0) daysAhead += 7;
    // "next X" when X hasn't passed yet this week → jump to next week's X
    if (qualifier === "next" && daysAhead < 7) daysAhead += 7;
    const result = new Date(today);
    result.setDate(result.getDate() + daysAhead);
    return formatDateLocal(result);
  }

  // Bare day name without qualifier: "fri", "saturday" → this coming occurrence
  const bareDay = text.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/i);
  if (bareDay) {
    const targetDay = days[bareDay[1]!.toLowerCase()];
    if (targetDay !== undefined) {
      const todayDay = today.getDay();
      let daysAhead = targetDay - todayDay;
      if (daysAhead <= 0) daysAhead += 7;
      const result = new Date(today);
      result.setDate(result.getDate() + daysAhead);
      return formatDateLocal(result);
    }
  }

  // "tomorrow"
  if (/\btomorrow\b/i.test(text)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return formatDateLocal(d);
  }

  return null;
}

/** Format a Date as YYYY-MM-DD in local time (avoids UTC timezone shift). */
function formatDateLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Extract aircraft class from text. */
export function extractAircraftClass(text: string): AircraftClass | null {
  const lower = text.toLowerCase();

  if (/\b(?:light\s*jet|cj3|phenom|learjet|citation\s*(?:cj|m2|mustang))\b/i.test(lower)) return "light";
  if (/\b(?:mid\s*(?:size|cabin)|latitude|lear\s*60|hawker|citation\s*(?:xls|excel))\b/i.test(lower)) return "midsize";
  if (/\b(?:super\s*mid|challenger\s*3\d*|g280|citation\s*x|praetor)\b/i.test(lower)) return "super_mid";
  if (/\b(?:heavy|large\s*cabin|g550|g650|falcon\s*(?:900|7x|8x)|challenger\s*(?:6|850))\b/i.test(lower)) return "heavy";
  if (/\b(?:ultra\s*long|global\s*(?:7500|6000|express)|g700)\b/i.test(lower)) return "ultra_long_range";

  // Indirect hints
  if (/\b(?:spacious|large|roomy|stand\s*up\s*cabin|flat\s*bed)\b/i.test(lower)) return "heavy";

  return null;
}

/** Extract departure and arrival from text. Returns [departure, arrival] ICAO or null. */
export function extractRoute(text: string): [string | null, string | null] {
  // Try patterns in order of specificity

  // 1. "from X to Y" — most explicit
  const fromToMatch = text.match(
    /(?:from|departing|leaving|out\s+of)\s+(.+?)\s+to\s+(.+?)(?:\s+(?:on|for|with|next|this|tomorrow|around|about|\d{1,2}[\/\-])|\s*[,.]|\s*$)/i,
  );
  if (fromToMatch) {
    const dep = resolveIcao(fromToMatch[1]!.trim());
    const arr = resolveIcao(fromToMatch[2]!.trim());
    if (dep || arr) return [dep, arr];
  }

  // 2. "X to Y" — without explicit "from"
  const simpleToMatch = text.match(
    /\b([A-Z]{4}|[A-Za-z][A-Za-z\s]{1,25}?)\s+to\s+([A-Z]{4}|[A-Za-z][A-Za-z\s]{1,25}?)(?:\s+(?:on|for|with|next|this|tomorrow|around|about|\d{1,2}[\/\-])|\s*[,.]|\s*$)/i,
  );
  if (simpleToMatch) {
    // Clean up: strip leading articles, prepositions, and noise words
    const depRaw = simpleToMatch[1]!
      .replace(/^(?:a\s+)?(?:flight|charter|jet|plane)\s+(?:from\s+)?/i, "")
      .replace(/^.*(?:route|from)\s+/i, "")
      .trim();
    const arrRaw = simpleToMatch[2]!.trim();
    const dep = resolveIcao(depRaw);
    const arr = resolveIcao(arrRaw);
    if (dep || arr) return [dep, arr];
  }

  // 3. Explicit departing/arriving keywords
  const depMatch = text.match(/(?:departing|depart|leaving|out\s+of|from)\s+([A-Za-z][A-Za-z\s]{1,25}?)(?:\s+(?:to|on|for|with|\d)|\s*[,.]|\s*$)/i);
  const dep = depMatch ? resolveIcao(depMatch[1]!.trim()) : null;

  const arrMatch = text.match(/(?:arriving|arrive|landing\s+at|going\s+to|destination|heading\s+to|to)\s+([A-Za-z][A-Za-z\s]{1,25}?)(?:\s+(?:on|for|with|\d)|\s*[,.]|\s*$)/i);
  const arr = arrMatch ? resolveIcao(arrMatch[1]!.trim()) : null;

  return [dep, arr];
}

/** Extract client name from text. */
export function extractClientName(text: string): string | null {
  // "this is [Name]" / "it's [Name]" / "my name is [Name]" / "I'm [Name]"
  const nameMatch = text.match(
    /(?:(?:this\s+is|it'?s|my\s+name\s+is|i'?m|i\s+am|name:?)\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
  );
  if (nameMatch) return nameMatch[1]!;

  // Email signature: "Best,\nName" / "Thanks,\nName" / "- Name"
  const sigMatch = text.match(
    /(?:best|thanks|regards|cheers|sincerely),?\s*[\n\r]+\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
  );
  if (sigMatch) return sigMatch[1]!;

  return null;
}

/** Extract contact info (email or phone) from text. */
export function extractContact(text: string): string | null {
  // Email
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (emailMatch) return emailMatch[0]!;

  // Phone: (XXX) XXX-XXXX or XXX-XXX-XXXX or +1XXXXXXXXXX
  const phoneMatch = text.match(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/);
  if (phoneMatch) return phoneMatch[0]!.trim();

  return null;
}

/** Detect if this is a round trip request. */
export function isRoundTrip(text: string): boolean {
  return /\b(?:round\s*trip|return|both\s*ways|back\s*and\s*forth|rt\b)/i.test(text);
}

/** Extract special requirements. */
export function extractSpecialRequirements(text: string): string[] {
  const reqs: string[] = [];
  const lower = text.toLowerCase();

  if (/\bpets?\b|\bdogs?\b|\bcats?\b/i.test(lower)) reqs.push("pets");
  if (/\b(?:ski\s*gear|skis?|skiing)\b/i.test(lower)) reqs.push("ski_gear");
  if (/\b(?:golf\s*clubs?|golf\s*bags?)\b/i.test(lower)) reqs.push("golf_clubs");
  if (/\b(?:wheelchair|handicap|disabled|mobility)\b/i.test(lower)) reqs.push("wheelchair");
  if (/\b(?:catering|food|meal|dinner|lunch)\b/i.test(lower)) reqs.push("catering");
  if (/\b(?:heavy\s*(?:luggage|bags)|oversized|surfboard|cargo)\b/i.test(lower)) reqs.push("heavy_luggage");

  return reqs;
}

// ── Parsed Request (intermediate) ────────────────────────────────────────

export interface ParsedRequest {
  departure: string | null;
  arrival: string | null;
  date: string | null;
  pax: number | null;
  aircraftClass: AircraftClass | null;
  budget: { min: number; max: number } | null;
  isRoundTrip: boolean;
  specialRequirements: string[];
  clientName: string | null;
  clientContact: string | null;
}

/**
 * Code-layer parser — extracts all structured fields from raw text.
 * No LLM call. Pure regex/pattern matching.
 */
export function parseRequestText(rawRequest: string, today?: Date): ParsedRequest {
  const [dep, arr] = extractRoute(rawRequest);

  return {
    departure: dep,
    arrival: arr,
    date: extractDate(rawRequest, today),
    pax: extractPax(rawRequest),
    aircraftClass: extractAircraftClass(rawRequest),
    budget: extractBudget(rawRequest),
    isRoundTrip: isRoundTrip(rawRequest),
    specialRequirements: extractSpecialRequirements(rawRequest),
    clientName: extractClientName(rawRequest),
    clientContact: extractContact(rawRequest),
  };
}

// ── LLM Parser Schema ────────────────────────────────────────────────────

export const LlmIntakeOutputSchema = z.object({
  departure_icao: z.string().nullable(),
  arrival_icao: z.string().nullable(),
  departure_city: z.string().nullable(),
  arrival_city: z.string().nullable(),
  date: z.string().nullable(),
  pax: z.number().int().nonnegative().nullable(),
  aircraft_class: z.enum(["light", "midsize", "super_mid", "heavy", "ultra_long_range"]).nullable(),
  budget_min: z.number().nullable(),
  budget_max: z.number().nullable(),
  is_round_trip: z.boolean(),
  special_requirements: z.array(z.string()),
  client_name: z.string().nullable(),
  client_contact: z.string().nullable(),
});
export type LlmIntakeOutput = z.infer<typeof LlmIntakeOutputSchema>;

export const INTAKE_SYSTEM_PROMPT = `You are the Intake parser for OSA Connect, a private charter brokerage. Parse the client request into structured JSON.

## OUTPUT FORMAT
Return ONLY valid JSON. No explanation, no markdown.

{
  "departure_icao": "KTEB" | null,
  "arrival_icao": "KPBI" | null,
  "departure_city": "New York" | null,
  "arrival_city": "Palm Beach" | null,
  "date": "2026-04-15" | null,
  "pax": 4 | null,
  "aircraft_class": "light" | "midsize" | "super_mid" | "heavy" | "ultra_long_range" | null,
  "budget_min": 20000 | null,
  "budget_max": 40000 | null,
  "is_round_trip": false,
  "special_requirements": ["pets", "ski_gear"],
  "client_name": "John Smith" | null,
  "client_contact": "john@example.com" | null
}

## AIRPORT RESOLUTION
- "NY", "New York", "NYC" → KTEB
- "South Florida", "Palm Beach" → KPBI
- "Chicago" → KORD
- "LA", "Los Angeles" → KVNY
- "Dallas" → KDAL
- "Houston" → KHOU
- "Vegas", "Las Vegas" → KLAS
- "Aspen" → KASE
- "Cabo" → MMSD, "Nassau" → MYNN, "Bermuda" → TXKF
- Always use 4-letter ICAO codes.

## BUDGET
- "$25k-$35k" → budget_min: 25000, budget_max: 35000
- "around $30k" → budget_min: 25500, budget_max: 34500
- "up to $40,000" → budget_min: 0, budget_max: 40000
- If not mentioned → null

## DATE
- Convert relative dates using the provided TODAY_DATE
- "next Friday" from 2026-03-31 = "2026-04-04" (or the correct next Friday)
- "April 15" → "2026-04-15"
- ISO format always

## SPECIAL REQUIREMENTS
Valid values: "pets", "ski_gear", "golf_clubs", "wheelchair", "catering", "heavy_luggage"`;

// ── Qualification Logic ──────────────────────────────────────────────────

export interface QualificationResult {
  qualified: boolean;
  reason: string;
  budgetMissing: boolean;
}

/**
 * Qualify a parsed request per spec.
 * - Reject if no valid route (need at least departure OR arrival ICAO)
 * - Reject if no date
 * - Reject if no pax
 * - Pause (not fail) if no budget — budgetMissing flag
 */
export function qualify(parsed: ParsedRequest): QualificationResult {
  // Must have at least one end of the route
  if (!parsed.departure && !parsed.arrival) {
    return { qualified: false, reason: "No valid route. Could not resolve departure or arrival airport.", budgetMissing: false };
  }

  if (!parsed.date) {
    return { qualified: false, reason: "No travel date specified.", budgetMissing: false };
  }

  if (!parsed.pax || parsed.pax <= 0) {
    return { qualified: false, reason: "No passenger count specified.", budgetMissing: false };
  }

  // Budget missing → qualified but flagged for pause
  if (!parsed.budget) {
    return { qualified: true, reason: "Qualified. Awaiting budget from client.", budgetMissing: true };
  }

  return { qualified: true, reason: "Fully qualified. Route, date, pax, and budget confirmed.", budgetMissing: false };
}

// ── Repeat Client Detection ──────────────────────────────────────────────

export interface RepeatClientInfo {
  isRepeat: boolean;
  previousDealCount: number;
  lastAircraftClass: string | null;
  lastBudget: { min: number; max: number } | null;
  substitutionPref: DealContext["client"]["substitutionPref"];
}

/**
 * Detect if the parsed request matches a repeat client in the DealStore.
 * Returns previous deal count, last aircraft class, and last budget for pre-population.
 * @param parsed - The parsed request with client name/contact.
 * @param dealStore - The deal store to search (null on cold start).
 * @returns Repeat client info with history data, or not-repeat defaults.
 */
export function detectRepeatClient(
  parsed: ParsedRequest,
  dealStore: DealStore | null,
): RepeatClientInfo {
  const notRepeat: RepeatClientInfo = {
    isRepeat: false, previousDealCount: 0,
    lastAircraftClass: null, lastBudget: null, substitutionPref: null,
  };

  if (!dealStore) return notRepeat;

  // Try matching by name or contact
  const searchTerms = [parsed.clientName, parsed.clientContact].filter(Boolean) as string[];
  if (searchTerms.length === 0) return notRepeat;

  for (const term of searchTerms) {
    const deals = dealStore.findClientDeals(term);
    if (deals.length > 0) {
      const latest = deals.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]!;
      return {
        isRepeat: true,
        previousDealCount: deals.length,
        lastAircraftClass: latest.aircraftClass,
        lastBudget: latest.clientBudget,
        substitutionPref: null, // Would come from a client preferences store in future
      };
    }
  }

  return notRepeat;
}

// ── Main Entry Point ─────────────────────────────────────────────────────

export interface IntakeOptions {
  /** DealStore for repeat client detection. Optional — null on cold start. */
  dealStore?: DealStore | null;
  /** Override the LLM parser — used in tests to avoid real API calls. */
  llmParser?: (rawRequest: string) => Promise<LlmIntakeOutput | null>;
  /** Today's date for relative date resolution. */
  today?: Date;
}

/**
 * Main intake capability — parse a raw client request into structured trip + client data.
 * Two-layer parser: code layer (regex) first, LLM fallback for missing critical fields.
 * Qualifies the client: rejects if no route/date/pax, pauses if no budget.
 * Detects repeat clients from DealStore memory and pre-populates preferences.
 * @param rawRequest - The raw client request text (email, SMS, form, etc.).
 * @param _ctx - The current deal context (unused — intake creates from scratch).
 * @param options - Optional: DealStore, LLM parser override, today's date.
 * @returns IntakeResult with client and trip sections for the DealContext.
 */
export async function intake(
  rawRequest: string,
  _ctx: DealContext,
  options: IntakeOptions = {},
): Promise<IntakeResult> {
  const { dealStore = null, llmParser, today } = options;

  // ── Step 1: Code-layer parse ───────────────────────────────────────
  let parsed = parseRequestText(rawRequest, today);

  // ── Step 2: LLM fallback for missing critical fields ───────────────
  // If code layer missed departure, arrival, date, or pax, try LLM
  const missingCritical = !parsed.departure || !parsed.arrival || !parsed.date || !parsed.pax;
  if (missingCritical && llmParser) {
    const llmResult = await llmParser(rawRequest);
    if (llmResult) {
      parsed = mergeLlmResult(parsed, llmResult);
    }
  }

  // ── Step 3: Qualify ────────────────────────────────────────────────
  const qual = qualify(parsed);

  // ── Step 4: Detect repeat client ───────────────────────────────────
  const repeatInfo = detectRepeatClient(parsed, dealStore);

  // Pre-populate from history if repeat and fields missing
  if (repeatInfo.isRepeat) {
    if (!parsed.aircraftClass && repeatInfo.lastAircraftClass) {
      const validated = AircraftClass.safeParse(repeatInfo.lastAircraftClass);
      if (validated.success) {
        parsed.aircraftClass = validated.data;
      }
    }
    if (!parsed.budget && repeatInfo.lastBudget) {
      parsed.budget = repeatInfo.lastBudget;
    }
  }

  // Re-qualify after repeat client enrichment (budget may now be filled)
  const finalQual = parsed.budget ? qualify(parsed) : qual;

  // ── Step 5: Build result ───────────────────────────────────────────
  return {
    client: {
      name: parsed.clientName ?? "",
      contact: parsed.clientContact ?? "",
      type: repeatInfo.isRepeat ? "repeat" : "new",
      budget: parsed.budget,
      substitutionPref: repeatInfo.substitutionPref,
      qualified: finalQual.qualified,
      qualificationReason: finalQual.reason,
    },
    trip: {
      departure: parsed.departure ?? "",
      arrival: parsed.arrival ?? "",
      date: parsed.date ?? "",
      pax: parsed.pax ?? 0,
      aircraftClass: parsed.aircraftClass,
      aircraftType: null,
      isRoundTrip: parsed.isRoundTrip,
      specialRequirements: parsed.specialRequirements,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Merge LLM output into parsed request, filling only null fields. */
function mergeLlmResult(parsed: ParsedRequest, llm: LlmIntakeOutput): ParsedRequest {
  return {
    departure: parsed.departure ?? (llm.departure_icao || resolveIcao(llm.departure_city ?? "")),
    arrival: parsed.arrival ?? (llm.arrival_icao || resolveIcao(llm.arrival_city ?? "")),
    date: parsed.date ?? llm.date,
    pax: parsed.pax ?? llm.pax,
    aircraftClass: parsed.aircraftClass ?? llm.aircraft_class,
    budget: parsed.budget ?? (llm.budget_min !== null && llm.budget_max !== null
      ? { min: llm.budget_min, max: llm.budget_max }
      : null),
    isRoundTrip: parsed.isRoundTrip || llm.is_round_trip,
    specialRequirements: parsed.specialRequirements.length > 0
      ? parsed.specialRequirements
      : llm.special_requirements,
    clientName: parsed.clientName ?? llm.client_name,
    clientContact: parsed.clientContact ?? llm.client_contact,
  };
}
