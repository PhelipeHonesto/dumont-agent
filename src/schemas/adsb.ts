/**
 * ADS-B schemas — aircraft position, completed leg, and state tracking.
 *
 * Schema only. No tables or persistence yet.
 * These power future ghost positioning detection and fleet intelligence.
 */

import { z } from "zod";

// ── ADS-B Position ──────────────────────────────────────────────────────
// Single position report from ADS-B feed (OpenSky / ADS-B Exchange).

export const AdsPositionSchema = z.object({
  icao24: z.string(),                           // ICAO 24-bit transponder address (hex)
  callsign: z.string().nullable(),               // Flight callsign (e.g., "N100JE")
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  altFt: z.number(),                             // Barometric altitude in feet
  groundSpeed: z.number().nonnegative(),         // Knots
  track: z.number().min(0).max(360),             // Heading in degrees true
  verticalRate: z.number(),                      // ft/min (positive = climbing)
  onGround: z.boolean(),
  timestamp: z.string(),                         // ISO 8601
  source: z.enum(["opensky", "adsbx", "flightaware", "sim"]).default("opensky"),
});
export type AdsPosition = z.infer<typeof AdsPositionSchema>;

// ── Completed Leg ───────────────────────────────────────────────────────
// Synthesized from position stream — one record per flight leg (gate-to-gate).

export const CompletedLegSchema = z.object({
  icao24: z.string(),
  tailNumber: z.string().nullable(),
  operatorName: z.string().nullable(),
  departureIcao: z.string(),                     // Inferred departure airport (ICAO)
  arrivalIcao: z.string(),                       // Inferred arrival airport (ICAO)
  departedAt: z.string(),                        // ISO 8601
  arrivedAt: z.string(),                         // ISO 8601
  durationMin: z.number().nonnegative(),
  distanceNm: z.number().nonnegative(),
  maxAltFt: z.number(),
  avgGroundSpeedKts: z.number().nonnegative(),
  isPositioning: z.boolean().default(false),     // True = empty leg / repositioning
  confidence: z.number().min(0).max(1),          // How confident we are in dep/arr inference
});
export type CompletedLeg = z.infer<typeof CompletedLegSchema>;

// ── Aircraft State ──────────────────────────────────────────────────────
// Current derived state for a tracked aircraft. Updated on every position.

export const AircraftStateSchema = z.object({
  icao24: z.string(),
  tailNumber: z.string().nullable(),
  operatorName: z.string().nullable(),
  lastPosition: AdsPositionSchema.nullable(),
  currentAirport: z.string().nullable(),         // ICAO if parked/taxiing, null if airborne
  status: z.enum(["airborne", "ground_idle", "ground_taxi", "unknown"]).default("unknown"),
  homeBase: z.string().nullable(),               // Inferred overnight parking base
  homeBaseConfidence: z.number().min(0).max(1).default(0),
  recentLegs: z.array(CompletedLegSchema).default([]),  // Last N legs (sliding window)
  lastSeen: z.string(),                          // ISO 8601
  updatedAt: z.string(),
});
export type AircraftState = z.infer<typeof AircraftStateSchema>;
