/**
 * Simulation fixture data — operators, airports, pricing calibration.
 * Migrated from ~/osa/simulator/src/fixtures/ and adapted for the
 * Dumont Agent schema (OperatorRecord, AirportCoords, mock Aviapages).
 */

import type { OperatorRecord, AirportCoords } from "../capabilities/sourcing.js";
import { haversine as haversineDist } from "../utils/haversine.js";
import type { OperatorCertData } from "../capabilities/guardian.js";
import type { AirportData } from "../capabilities/guardian.js";
import type { PriceEstimateResult } from "../integrations/aviapages.js";

// ── Airports ─────────────────────────────────────────────────────────────

export const AIRPORTS: Map<string, AirportData & AirportCoords> = new Map([
  ["KTEB", { icao: "KTEB", latitude: 40.8501, longitude: -74.0608, longest_runway_ft: 7000, customs_capable: true }],
  ["KPBI", { icao: "KPBI", latitude: 26.6832, longitude: -80.0956, longest_runway_ft: 10008, customs_capable: true }],
  ["KASE", { icao: "KASE", latitude: 39.2232, longitude: -106.8688, longest_runway_ft: 8006, customs_capable: false }],
  ["KORD", { icao: "KORD", latitude: 41.9742, longitude: -87.9073, longest_runway_ft: 13000, customs_capable: true }],
  ["KMDW", { icao: "KMDW", latitude: 41.7868, longitude: -87.7522, longest_runway_ft: 6522, customs_capable: true }],
  ["KPWK", { icao: "KPWK", latitude: 42.1142, longitude: -87.9015, longest_runway_ft: 5000, customs_capable: true }],
  ["KMIA", { icao: "KMIA", latitude: 25.7959, longitude: -80.2870, longest_runway_ft: 13016, customs_capable: true }],
  ["KFLL", { icao: "KFLL", latitude: 26.0726, longitude: -80.1527, longest_runway_ft: 9000, customs_capable: true }],
  ["KVNY", { icao: "KVNY", latitude: 34.2098, longitude: -118.4900, longest_runway_ft: 8001, customs_capable: true }],
  ["KLAS", { icao: "KLAS", latitude: 36.0840, longitude: -115.1537, longest_runway_ft: 14510, customs_capable: true }],
  ["KDAL", { icao: "KDAL", latitude: 32.8471, longitude: -96.8517, longest_runway_ft: 8800, customs_capable: true }],
  ["KHOU", { icao: "KHOU", latitude: 29.6454, longitude: -95.2789, longest_runway_ft: 7602, customs_capable: true }],
  ["KHPN", { icao: "KHPN", latitude: 41.0670, longitude: -73.7076, longest_runway_ft: 6549, customs_capable: true }],
  ["KEGE", { icao: "KEGE", latitude: 39.6426, longitude: -106.9159, longest_runway_ft: 8150, customs_capable: false }],
  ["KPTK", { icao: "KPTK", latitude: 42.6655, longitude: -83.4200, longest_runway_ft: 5000, customs_capable: false }],
  ["MYNN", { icao: "MYNN", latitude: 25.0390, longitude: -77.4662, longest_runway_ft: 11000, customs_capable: true }],
  ["MMSD", { icao: "MMSD", latitude: 23.1518, longitude: -109.7215, longest_runway_ft: 9843, customs_capable: true }],
  ["TXKF", { icao: "TXKF", latitude: 32.3640, longitude: -64.6787, longest_runway_ft: 9713, customs_capable: true }],
]);

// ── Operators ────────────────────────────────────────────────────────────
// Migrated from simulator operators.json, adapted to OperatorRecord shape.
// Each fleet aircraft becomes a separate OperatorRecord entry.

export const OPERATORS: OperatorRecord[] = [
  // Priester Aviation (KPWK) — light + super_mid
  { operatorId: "op_001a", operatorName: "Priester Aviation", phone: "+1-847-484-5557", baseAirport: "KPWK", baseLatitude: 42.1142, baseLongitude: -87.9015, aircraftType: "Phenom 300E", aircraftTail: "N300PA", aircraftCategory: "light", passengerCapacity: 8, rangeNm: 2010 },
  { operatorId: "op_001b", operatorName: "Priester Aviation", phone: "+1-847-484-5557", baseAirport: "KPWK", baseLatitude: 42.1142, baseLongitude: -87.9015, aircraftType: "Citation X+", aircraftTail: "N510PA", aircraftCategory: "super_mid", passengerCapacity: 8, rangeNm: 3070 },
  // Jet Linx (KMDW + KTEB) — super_mid + midsize
  { operatorId: "op_002a", operatorName: "Jet Linx", phone: "+1-866-538-5469", baseAirport: "KTEB", baseLatitude: 40.8501, baseLongitude: -74.0608, aircraftType: "Challenger 300", aircraftTail: "N300JL", aircraftCategory: "super_mid", passengerCapacity: 9, rangeNm: 3100 },
  { operatorId: "op_002b", operatorName: "Jet Linx", phone: "+1-866-538-5469", baseAirport: "KTEB", baseLatitude: 40.8501, baseLongitude: -74.0608, aircraftType: "Citation Latitude", aircraftTail: "N680JL", aircraftCategory: "midsize", passengerCapacity: 9, rangeNm: 2700 },
  // CMC Jets (KPWK) — light
  { operatorId: "op_003", operatorName: "CMC Jets", phone: "+1-847-541-0500", baseAirport: "KPWK", baseLatitude: 42.1142, baseLongitude: -87.9015, aircraftType: "Citation CJ3+", aircraftTail: "N525CM", aircraftCategory: "light", passengerCapacity: 7, rangeNm: 2040 },
  // Pentastar Aviation (KPTK) — heavy + super_mid
  { operatorId: "op_004a", operatorName: "Pentastar Aviation", phone: "+1-248-666-8800", baseAirport: "KPTK", baseLatitude: 42.6655, baseLongitude: -83.4200, aircraftType: "Gulfstream G550", aircraftTail: "N550PS", aircraftCategory: "heavy", passengerCapacity: 14, rangeNm: 6750 },
  { operatorId: "op_004b", operatorName: "Pentastar Aviation", phone: "+1-248-666-8800", baseAirport: "KPTK", baseLatitude: 42.6655, baseLongitude: -83.4200, aircraftType: "Challenger 300", aircraftTail: "N300PS", aircraftCategory: "super_mid", passengerCapacity: 9, rangeNm: 3100 },
  // Solairus Aviation (KVNY + KMDW) — super_mid + heavy
  { operatorId: "op_005a", operatorName: "Solairus Aviation", phone: "+1-707-528-7775", baseAirport: "KVNY", baseLatitude: 34.2098, baseLongitude: -118.4900, aircraftType: "Gulfstream G280", aircraftTail: "N280SA", aircraftCategory: "super_mid", passengerCapacity: 10, rangeNm: 3600 },
  { operatorId: "op_005b", operatorName: "Solairus Aviation", phone: "+1-707-528-7775", baseAirport: "KVNY", baseLatitude: 34.2098, baseLongitude: -118.4900, aircraftType: "Gulfstream G550", aircraftTail: "N550SA", aircraftCategory: "heavy", passengerCapacity: 14, rangeNm: 6750 },
  // Nicholas Air (KTUP) — light + midsize
  { operatorId: "op_006a", operatorName: "Nicholas Air", phone: "+1-866-935-7771", baseAirport: "KPBI", baseLatitude: 26.6832, baseLongitude: -80.0956, aircraftType: "Phenom 300E", aircraftTail: "N300NA", aircraftCategory: "light", passengerCapacity: 8, rangeNm: 2010 },
  { operatorId: "op_006b", operatorName: "Nicholas Air", phone: "+1-866-935-7771", baseAirport: "KPBI", baseLatitude: 26.6832, baseLongitude: -80.0956, aircraftType: "Citation Latitude", aircraftTail: "N680NA", aircraftCategory: "midsize", passengerCapacity: 9, rangeNm: 2700 },
  // Flexjet (KDAL) — all classes
  { operatorId: "op_007a", operatorName: "Flexjet", phone: "+1-866-933-5393", baseAirport: "KDAL", baseLatitude: 32.8471, baseLongitude: -96.8517, aircraftType: "Phenom 300E", aircraftTail: "N300FX", aircraftCategory: "light", passengerCapacity: 8, rangeNm: 2010 },
  { operatorId: "op_007b", operatorName: "Flexjet", phone: "+1-866-933-5393", baseAirport: "KDAL", baseLatitude: 32.8471, baseLongitude: -96.8517, aircraftType: "Challenger 300", aircraftTail: "N300FJ", aircraftCategory: "super_mid", passengerCapacity: 9, rangeNm: 3100 },
  { operatorId: "op_007c", operatorName: "Flexjet", phone: "+1-866-933-5393", baseAirport: "KDAL", baseLatitude: 32.8471, baseLongitude: -96.8517, aircraftType: "Gulfstream G550", aircraftTail: "N550FJ", aircraftCategory: "heavy", passengerCapacity: 14, rangeNm: 6750 },
  // Wheels Up (KLAS) — light
  { operatorId: "op_008", operatorName: "Wheels Up", phone: "+1-855-359-2872", baseAirport: "KLAS", baseLatitude: 36.0840, baseLongitude: -115.1537, aircraftType: "King Air 350i", aircraftTail: "N350WU", aircraftCategory: "light", passengerCapacity: 9, rangeNm: 1806 },
];

// ── Operator Certifications ──────────────────────────────────────────────

export const OPERATOR_CERTS: Map<string, OperatorCertData> = new Map(
  OPERATORS.map((op) => [
    op.operatorId,
    {
      operatorId: op.operatorId,
      part135Active: true,
      insuranceCurrent: true,
      argusRating: "gold" as const,
      wyvernRating: null,
    },
  ]),
);

// ── Mock Aviapages Pricing ───────────────────────────────────────────────
// Based on ~/osa/simulator/src/fixtures/pricing-calibration.json

const ROUTE_PRICING: Record<string, Record<string, { low: number; high: number; flightTime: number; fuelBurn: number }>> = {
  "KTEB-KPBI": {
    light: { low: 24000, high: 32000, flightTime: 155, fuelBurn: 280 },
    midsize: { low: 30000, high: 42000, flightTime: 145, fuelBurn: 360 },
    super_mid: { low: 38000, high: 52000, flightTime: 135, fuelBurn: 420 },
    heavy: { low: 52000, high: 72000, flightTime: 130, fuelBurn: 580 },
  },
  "KORD-KASE": {
    light: { low: 26000, high: 34000, flightTime: 195, fuelBurn: 320 },
    midsize: { low: 34000, high: 46000, flightTime: 180, fuelBurn: 420 },
    super_mid: { low: 42000, high: 58000, flightTime: 170, fuelBurn: 490 },
    heavy: { low: 55000, high: 75000, flightTime: 165, fuelBurn: 640 },
  },
  "KVNY-MMSD": {
    light: { low: 22000, high: 30000, flightTime: 165, fuelBurn: 290 },
    super_mid: { low: 36000, high: 50000, flightTime: 150, fuelBurn: 430 },
    heavy: { low: 50000, high: 68000, flightTime: 145, fuelBurn: 580 },
  },
  "KTEB-MYNN": {
    light: { low: 28000, high: 38000, flightTime: 175, fuelBurn: 310 },
    super_mid: { low: 42000, high: 56000, flightTime: 160, fuelBurn: 440 },
    heavy: { low: 55000, high: 75000, flightTime: 155, fuelBurn: 600 },
  },
  "KDAL-KPBI": {
    light: { low: 22000, high: 30000, flightTime: 165, fuelBurn: 280 },
    midsize: { low: 28000, high: 38000, flightTime: 155, fuelBurn: 350 },
  },
  "KHOU-KDAL": {
    light: { low: 8000, high: 14000, flightTime: 50, fuelBurn: 90 },
  },
  "KLAS-KVNY": {
    light: { low: 9000, high: 15000, flightTime: 55, fuelBurn: 100 },
  },
  "KORD-KPBI": {
    light: { low: 26000, high: 34000, flightTime: 170, fuelBurn: 300 },
    midsize: { low: 32000, high: 44000, flightTime: 160, fuelBurn: 380 },
    super_mid: { low: 40000, high: 54000, flightTime: 150, fuelBurn: 450 },
  },
  "KFLL-KORD": {
    light: { low: 26000, high: 34000, flightTime: 175, fuelBurn: 300 },
    midsize: { low: 32000, high: 44000, flightTime: 165, fuelBurn: 380 },
  },
  "KORD-KLAS": {
    super_mid: { low: 38000, high: 52000, flightTime: 210, fuelBurn: 460 },
    heavy: { low: 50000, high: 68000, flightTime: 200, fuelBurn: 600 },
  },
  "KORD-KMIA": {
    light: { low: 28000, high: 36000, flightTime: 180, fuelBurn: 310 },
    midsize: { low: 34000, high: 46000, flightTime: 170, fuelBurn: 400 },
  },
  "KPBI-KORD": {
    light: { low: 26000, high: 34000, flightTime: 170, fuelBurn: 300 },
  },
  "KDAL-TXKF": {
    super_mid: { low: 42000, high: 58000, flightTime: 240, fuelBurn: 500 },
    heavy: { low: 55000, high: 75000, flightTime: 230, fuelBurn: 640 },
  },
  "KVNY-KASE": {
    light: { low: 18000, high: 26000, flightTime: 130, fuelBurn: 230 },
    heavy: { low: 42000, high: 58000, flightTime: 120, fuelBurn: 480 },
  },
  "KHPN-KMIA": {
    midsize: { low: 30000, high: 42000, flightTime: 175, fuelBurn: 370 },
  },
};

/**
 * Mock Aviapages pricing lookup. Returns estimate for a route + class combo.
 * Falls back to generic distance-based pricing if no specific data.
 */
export function mockAviapagesEstimate(
  departure: string,
  arrival: string,
  aircraftClass: string | null,
): PriceEstimateResult | null {
  const routeKey = `${departure}-${arrival}`;
  const reverseKey = `${arrival}-${departure}`;
  const routeData = ROUTE_PRICING[routeKey] ?? ROUTE_PRICING[reverseKey];

  if (routeData) {
    // Try exact class match, then any available
    const cls = aircraftClass ?? "light";
    const match = routeData[cls] ?? Object.values(routeData)[0];
    if (match) return match;
  }

  // Fallback: distance-based generic pricing
  const dep = AIRPORTS.get(departure);
  const arr = AIRPORTS.get(arrival);
  if (!dep || !arr) return null;

  const dist = haversineDist(dep.latitude, dep.longitude, arr.latitude, arr.longitude);
  const perNm = aircraftClass === "heavy" ? 40 : aircraftClass === "super_mid" ? 30 : aircraftClass === "midsize" ? 25 : 18;
  const base = Math.round(dist * perNm);

  return {
    low: Math.round(base * 0.85),
    high: Math.round(base * 1.15),
    flightTime: Math.round(dist / 7), // ~420 ktas average
    fuelBurn: Math.round(dist * 0.3),
  };
}
