/**
 * Dumont Brain — conversational engine.
 * Extracts trip fields, qualifies the caller, runs estimate + sourcing,
 * and returns what Dumont should say next.
 * Stateless per-request; state is held in an in-memory session map keyed by call_id.
 */

import {
  extractRoute, extractPax, extractDate, extractBudget,
  extractAircraftClass, resolveIcao,
} from "../capabilities/intake.js";
import { classifyLead } from "../capabilities/sdr.js";
import { mockAviapagesEstimate, OPERATORS, AIRPORTS } from "../fixtures/sim-data.js";
import { scoreOperator, type ScoredOperator } from "../capabilities/sourcing.js";

// ── Types ────────────────────────────────────────────────────────────────

interface ExtractedFields {
  departure: string | null;
  arrival: string | null;
  date: string | null;
  pax: number | null;
  budget: { min: number; max: number } | null;
  aircraftClass: string | null;
}

export interface ConversationInput {
  call_id: string;
  transcript: string;
  last_utterance: string;
  extracted: Record<string, unknown> | null;
}

export interface DumontResponse {
  response: string;
  action: "continue" | "transfer" | "end";
  transfer_to?: string;
  deal_data: Record<string, unknown>;
}

// ── Session State ────────────────────────────────────────────────────────

interface ConversationState {
  fields: ExtractedFields;
  turnCount: number;
  qualified: boolean;
  estimateReturned: boolean;
  lastAccess: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_SESSIONS = 1000;
const sessions = new Map<string, ConversationState>();

// Evict stale sessions every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, state] of sessions) {
    if (state.lastAccess < cutoff) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

function getOrCreate(callId: string): ConversationState {
  let state = sessions.get(callId);
  if (!state) {
    // LRU eviction: if at capacity, delete the oldest session
    if (sessions.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAccess = Infinity;
      for (const [key, s] of sessions) {
        if (s.lastAccess < oldestAccess) {
          oldestAccess = s.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    state = {
      fields: { departure: null, arrival: null, date: null, pax: null, budget: null, aircraftClass: null },
      turnCount: 0,
      qualified: false,
      estimateReturned: false,
      lastAccess: Date.now(),
    };
    sessions.set(callId, state);
  }
  state.lastAccess = Date.now();
  return state;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const BROKER_PHONE = process.env.BROKER_PHONE ?? "+1-312-555-0100";

const ICAO_TO_CITY: Record<string, string> = {
  KTEB: "Teterboro", KPBI: "Palm Beach", KASE: "Aspen",
  KORD: "Chicago", KMDW: "Midway", KPWK: "Chicago Executive",
  KMIA: "Miami", KFLL: "Fort Lauderdale", KVNY: "Van Nuys",
  KLAS: "Las Vegas", KDAL: "Dallas", KHOU: "Houston",
  KHPN: "Westchester", KEGE: "Vail", MYNN: "Nassau",
  MMSD: "Cabo", TXKF: "Bermuda",
};

function cityName(icao: string): string {
  return ICAO_TO_CITY[icao] ?? icao;
}

function formatPrice(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)} thousand`;
  return n.toLocaleString();
}

function formatDateNatural(iso: string | null): string {
  if (!iso) return "your requested date";
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const month = months[parseInt(parts[1]!, 10) - 1] ?? parts[1];
  const day = parseInt(parts[2]!, 10);
  return `${month} ${day}`;
}

function classToName(cls: string | null): string {
  switch (cls) {
    case "light": return "Phenom 300E";
    case "midsize": return "Citation Latitude";
    case "super_mid": return "Challenger 300";
    case "heavy": return "Gulfstream G550";
    case "ultra_long_range": return "Global 7500";
    default: return "light jet";
  }
}

function buildContinue(text: string, fields: ExtractedFields): DumontResponse {
  return {
    response: text,
    action: "continue",
    deal_data: {
      departure: fields.departure,
      arrival: fields.arrival,
      date: fields.date,
      pax: fields.pax,
    },
  };
}

// ── Core Logic ───────────────────────────────────────────────────────────

export function processConversation(input: ConversationInput): DumontResponse {
  const { call_id, transcript, last_utterance, extracted } = input;

  const state = getOrCreate(call_id);
  state.turnCount++;

  const fields = state.fields;

  // Extract from last utterance
  if (last_utterance) {
    const [dep, arr] = extractRoute(last_utterance);
    if (dep) fields.departure = dep;
    if (arr) fields.arrival = arr;

    const date = extractDate(last_utterance);
    if (date) fields.date = date;

    const pax = extractPax(last_utterance);
    if (pax) fields.pax = pax;

    const budget = extractBudget(last_utterance);
    if (budget) fields.budget = budget;

    const ac = extractAircraftClass(last_utterance);
    if (ac) fields.aircraftClass = ac;
  }

  // Merge pre-extracted fields (from adapters that do their own extraction)
  if (extracted) {
    if (extracted.departure && !fields.departure) {
      fields.departure = resolveIcao(extracted.departure as string) ?? fields.departure;
    }
    if (extracted.arrival && !fields.arrival) {
      fields.arrival = resolveIcao(extracted.arrival as string) ?? fields.arrival;
    }
    if (extracted.date && !fields.date) {
      fields.date = extractDate(extracted.date as string) ?? fields.date;
    }
    if (extracted.pax && !fields.pax) {
      fields.pax = typeof extracted.pax === "number" ? extracted.pax : null;
    }
  }

  // Greeting (empty transcript)
  if (!transcript && !last_utterance) {
    return {
      response: "Thank you for calling Orange Sunshine Aviation. This is Dumont, your charter assistant. This call may be recorded for quality. How can I help you today?",
      action: "continue",
      deal_data: {},
    };
  }

  // Not charter related
  const sdr = classifyLead(transcript || last_utterance);
  if (state.turnCount >= 2 && sdr.classification === "not_qualified" && sdr.extractedFields.length === 0) {
    const hasAnything = fields.departure || fields.arrival || fields.date || fields.pax;
    if (!hasAnything) {
      return {
        response: "I appreciate the call, but we specialize in private charter flights. Is there a trip I can help you arrange?",
        action: "continue",
        deal_data: {},
      };
    }
  }

  // Ask for missing fields
  if (!fields.departure) return buildContinue("Where will you be flying from?", fields);
  if (!fields.arrival) return buildContinue("And where are you headed?", fields);
  if (!fields.date) return buildContinue("When do you need to fly?", fields);
  if (!fields.pax) return buildContinue("How many passengers will be traveling?", fields);

  // All info present — run estimate + sourcing
  if (state.estimateReturned) {
    return buildContinue("Phelipe will have your exact quote shortly. Is there anything else I can help with?", fields);
  }

  state.qualified = true;
  state.estimateReturned = true;

  if (!fields.aircraftClass) {
    if (fields.pax <= 7) fields.aircraftClass = "light";
    else if (fields.pax <= 9) fields.aircraftClass = "super_mid";
    else fields.aircraftClass = "heavy";
  }

  const est = mockAviapagesEstimate(fields.departure, fields.arrival, fields.aircraftClass);

  const depAirport = AIRPORTS.get(fields.departure) ?? null;
  const viable = OPERATORS.filter((op) => {
    if (op.passengerCapacity < (fields.pax ?? 1)) return false;
    if (fields.aircraftClass && op.aircraftCategory !== fields.aircraftClass) return false;
    return true;
  });

  let topOperator: ScoredOperator | null = null;
  if (viable.length > 0 && depAirport) {
    const scored = viable.map((op) =>
      scoreOperator(op, depAirport, fields.departure!, fields.arrival!, null),
    );
    scored.sort((a, b) => b.score - a.score);
    topOperator = scored[0]!;
  }

  const depCity = cityName(fields.departure);
  const arrCity = cityName(fields.arrival);
  const dateStr = formatDateNatural(fields.date);
  const acName = topOperator?.operator.aircraftType ?? classToName(fields.aircraftClass);
  const opName = topOperator?.operator.operatorName ?? null;

  let spokenResponse: string;
  if (est) {
    const low = formatPrice(est.low);
    const high = formatPrice(est.high);
    spokenResponse = `For ${depCity} to ${arrCity} on ${dateStr} with ${fields.pax} passengers, you're looking at a ${acName}. Roughly ${low} to ${high} all-in.`;
    if (opName) spokenResponse += ` ${opName} runs that route regularly.`;
    spokenResponse += " Let me connect you with Phelipe, he'll have your exact quote within minutes.";
  } else {
    spokenResponse = `I have your trip from ${depCity} to ${arrCity} on ${dateStr} with ${fields.pax} passengers. Let me connect you with Phelipe to get you a precise quote on a ${acName}.`;
  }

  const dealData: Record<string, unknown> = {
    departure: fields.departure,
    arrival: fields.arrival,
    date: fields.date,
    pax: fields.pax,
    aircraft_class: fields.aircraftClass,
    aircraft_name: acName,
    qualified: true,
  };

  if (est) {
    dealData.estimate_low = est.low;
    dealData.estimate_high = est.high;
  }
  if (opName) {
    dealData.top_operator = opName;
  }

  return {
    response: spokenResponse,
    action: "transfer",
    transfer_to: BROKER_PHONE,
    deal_data: dealData,
  };
}
