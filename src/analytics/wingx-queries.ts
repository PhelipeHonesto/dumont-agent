/**
 * WINGX-equivalent query layer.
 *
 * Read-only functions that query the analytics tables
 * for API endpoints and MCP tools.
 */

import type Database from "better-sqlite3";

// ── Types ───────────────────────────────────────────────────────────────────

export interface MarketOverview {
  month: string;
  totalLegs: number;
  totalFlightHours: number;
  totalOperators: number;
  totalAircraft: number;
  topOperators: Array<{
    name: string;
    legs: number;
    marketSharePct: number;
    topRoute: string | null;
  }>;
  classMix: Record<string, number>;
}

export interface OperatorProfile {
  name: string;
  months: Array<{
    month: string;
    legs: number;
    flightHours: number;
    marketSharePct: number;
    avgFlightTimeMin: number;
    topRoute: string | null;
    aircraftClasses: string[];
  }>;
  totalLegs: number;
  totalFlightHours: number;
  aircraftCount: number;
  topAircraft: Array<{ tailNumber: string; legs: number; hours: number }>;
}

export interface AirportReport {
  icao: string;
  date: string;
  totalMovements: number;
  totalDepartures: number;
  totalArrivals: number;
  peakHour: number;
  peakMovements: number;
  hourly: Array<{
    hour: number;
    departures: number;
    arrivals: number;
    total: number;
    charterMovements: number;
  }>;
  topOperators: Array<{ name: string; legs: number }>;
}

export interface RouteTrend {
  origin: string;
  destination: string;
  monthly: Array<{
    month: string;
    flights: number;
    avgFlightTimeMin: number;
    dominantClass: string | null;
    yoyChangePct: number | null;
  }>;
  totalFlights: number;
  classMix: Record<string, number>;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function getMarketOverview(db: Database.Database, month?: string): MarketOverview {
  const targetMonth = month ?? currentMonth();

  const operators = db.prepare(`
    SELECT operator_name, total_legs, total_flight_hours, market_share_pct, top_route
    FROM operator_market_share
    WHERE month = ?
    ORDER BY total_legs DESC
    LIMIT 25
  `).all(targetMonth) as Array<{
    operator_name: string;
    total_legs: number;
    total_flight_hours: number;
    market_share_pct: number;
    top_route: string | null;
  }>;

  const totals = db.prepare(`
    SELECT SUM(total_legs) as legs, SUM(total_flight_hours) as hours,
           COUNT(*) as operators
    FROM operator_market_share WHERE month = ?
  `).get(targetMonth) as { legs: number | null; hours: number | null; operators: number };

  const aircraftCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM aircraft_utilization WHERE month = ?
  `).get(targetMonth) as { cnt: number };

  // Class mix from utilization
  const classMixRows = db.prepare(`
    SELECT aircraft_class, SUM(total_legs) as legs
    FROM aircraft_utilization
    WHERE month = ? AND aircraft_class IS NOT NULL
    GROUP BY aircraft_class ORDER BY legs DESC
  `).all(targetMonth) as Array<{ aircraft_class: string; legs: number }>;

  const classMix: Record<string, number> = {};
  for (const r of classMixRows) classMix[r.aircraft_class] = r.legs;

  return {
    month: targetMonth,
    totalLegs: totals.legs ?? 0,
    totalFlightHours: totals.hours ?? 0,
    totalOperators: totals.operators,
    totalAircraft: aircraftCount.cnt,
    topOperators: operators.map((o) => ({
      name: o.operator_name,
      legs: o.total_legs,
      marketSharePct: o.market_share_pct,
      topRoute: o.top_route,
    })),
    classMix,
  };
}

export function getOperatorProfile(
  db: Database.Database,
  operatorName: string,
  monthsBack = 6,
): OperatorProfile {
  const months = db.prepare(`
    SELECT month, total_legs, total_flight_hours, market_share_pct,
           avg_flight_time_min, top_route, aircraft_classes
    FROM operator_market_share
    WHERE operator_name = ?
    ORDER BY month DESC
    LIMIT ?
  `).all(operatorName, monthsBack) as Array<{
    month: string;
    total_legs: number;
    total_flight_hours: number;
    market_share_pct: number;
    avg_flight_time_min: number;
    top_route: string | null;
    aircraft_classes: string | null;
  }>;

  const totalRow = db.prepare(`
    SELECT SUM(total_legs) as legs, SUM(total_flight_hours) as hours
    FROM operator_market_share WHERE operator_name = ?
  `).get(operatorName) as { legs: number | null; hours: number | null };

  // Top aircraft by utilization (most recent month with data)
  const latestMonth = months[0]?.month ?? currentMonth();
  const topAircraft = db.prepare(`
    SELECT tail_number, total_legs, total_flight_hours
    FROM aircraft_utilization
    WHERE operator_name = ? AND month = ?
    ORDER BY total_legs DESC LIMIT 10
  `).all(operatorName, latestMonth) as Array<{
    tail_number: string; total_legs: number; total_flight_hours: number;
  }>;

  const aircraftCount = db.prepare(`
    SELECT COUNT(DISTINCT tail_number) as cnt FROM aircraft_utilization
    WHERE operator_name = ?
  `).get(operatorName) as { cnt: number };

  return {
    name: operatorName,
    months: months.map((m) => ({
      month: m.month,
      legs: m.total_legs,
      flightHours: m.total_flight_hours,
      marketSharePct: m.market_share_pct,
      avgFlightTimeMin: m.avg_flight_time_min,
      topRoute: m.top_route,
      aircraftClasses: safeParseArray(m.aircraft_classes),
    })),
    totalLegs: totalRow.legs ?? 0,
    totalFlightHours: totalRow.hours ?? 0,
    aircraftCount: aircraftCount.cnt,
    topAircraft: topAircraft.map((a) => ({
      tailNumber: a.tail_number,
      legs: a.total_legs,
      hours: a.total_flight_hours,
    })),
  };
}

export function getAirportReport(
  db: Database.Database,
  icao: string,
  date?: string,
): AirportReport {
  const targetDate = date ?? today();

  const hourly = db.prepare(`
    SELECT hour, departures, arrivals, total_movements, charter_movements
    FROM airport_activity
    WHERE airport_icao = ? AND date = ?
    ORDER BY hour
  `).all(icao, targetDate) as Array<{
    hour: number; departures: number; arrivals: number;
    total_movements: number; charter_movements: number;
  }>;

  let totalDep = 0, totalArr = 0, peakHour = 0, peakMov = 0;
  for (const h of hourly) {
    totalDep += h.departures;
    totalArr += h.arrivals;
    if (h.total_movements > peakMov) {
      peakMov = h.total_movements;
      peakHour = h.hour;
    }
  }

  // Top operators at this airport (from legs data)
  const topOps = db.prepare(`
    SELECT operator_name, COUNT(*) as legs
    FROM adsb_completed_legs
    WHERE (origin_icao = ? OR destination_icao = ?)
      AND departure_time >= ? AND departure_time <= ?
      AND operator_name IS NOT NULL AND operator_name != ''
    GROUP BY operator_name ORDER BY legs DESC LIMIT 10
  `).all(icao, icao, `${targetDate} 00:00:00`, `${targetDate} 23:59:59`) as Array<{
    operator_name: string; legs: number;
  }>;

  return {
    icao,
    date: targetDate,
    totalMovements: totalDep + totalArr,
    totalDepartures: totalDep,
    totalArrivals: totalArr,
    peakHour,
    peakMovements: peakMov,
    hourly: hourly.map((h) => ({
      hour: h.hour,
      departures: h.departures,
      arrivals: h.arrivals,
      total: h.total_movements,
      charterMovements: h.charter_movements,
    })),
    topOperators: topOps.map((o) => ({ name: o.operator_name, legs: o.legs })),
  };
}

export function getRouteTrend(
  db: Database.Database,
  origin: string,
  destination: string,
  monthsBack = 12,
): RouteTrend {
  const monthly = db.prepare(`
    SELECT month, total_flights, avg_flight_time_min, dominant_class,
           class_breakdown, yoy_change_pct
    FROM route_trends
    WHERE origin_icao = ? AND destination_icao = ?
    ORDER BY month DESC
    LIMIT ?
  `).all(origin, destination, monthsBack) as Array<{
    month: string; total_flights: number; avg_flight_time_min: number;
    dominant_class: string | null; class_breakdown: string | null;
    yoy_change_pct: number | null;
  }>;

  let totalFlights = 0;
  const classMix: Record<string, number> = {};
  for (const m of monthly) {
    totalFlights += m.total_flights;
    const breakdown = safeParseObj(m.class_breakdown);
    for (const [cls, cnt] of Object.entries(breakdown)) {
      classMix[cls] = (classMix[cls] ?? 0) + (cnt as number);
    }
  }

  return {
    origin,
    destination,
    monthly: monthly.map((m) => ({
      month: m.month,
      flights: m.total_flights,
      avgFlightTimeMin: m.avg_flight_time_min,
      dominantClass: m.dominant_class,
      yoyChangePct: m.yoy_change_pct,
    })),
    totalFlights,
    classMix,
  };
}

export function getFleetHealth(
  db: Database.Database,
  aircraftClass?: string,
): Array<Record<string, unknown>> {
  const query = aircraftClass
    ? `SELECT * FROM fleet_snapshot WHERE aircraft_class = ? ORDER BY date DESC LIMIT 12`
    : `SELECT * FROM fleet_snapshot ORDER BY date DESC, aircraft_class LIMIT 60`;

  return aircraftClass
    ? db.prepare(query).all(aircraftClass) as Array<Record<string, unknown>>
    : db.prepare(query).all() as Array<Record<string, unknown>>;
}

export function getTopRoutes(
  db: Database.Database,
  month?: string,
  limit = 20,
): Array<Record<string, unknown>> {
  const targetMonth = month ?? currentMonth();
  return db.prepare(`
    SELECT origin_icao, destination_icao, total_flights, avg_flight_time_min,
           dominant_class, class_breakdown, yoy_change_pct
    FROM route_trends
    WHERE month = ?
    ORDER BY total_flights DESC
    LIMIT ?
  `).all(targetMonth, limit) as Array<Record<string, unknown>>;
}

export function getTopOperators(
  db: Database.Database,
  month?: string,
  limit = 20,
): Array<Record<string, unknown>> {
  const targetMonth = month ?? currentMonth();
  return db.prepare(`
    SELECT operator_name, total_legs, total_flight_hours, market_share_pct,
           avg_flight_time_min, top_route, aircraft_classes
    FROM operator_market_share
    WHERE month = ?
    ORDER BY total_legs DESC
    LIMIT ?
  `).all(targetMonth, limit) as Array<Record<string, unknown>>;
}

export function getFuelEstimate(
  db: Database.Database,
  origin: string,
  destination: string,
  aircraftClass: string,
): Record<string, unknown> {
  // Get average flight time for this route+class
  const routeStats = db.prepare(`
    SELECT ROUND(AVG(flight_time_min), 1) as avg_time_min,
           ROUND(AVG(distance_nm), 1) as avg_distance_nm
    FROM adsb_completed_legs
    WHERE origin_icao = ? AND destination_icao = ? AND aircraft_class = ?
  `).get(origin, destination, aircraftClass) as { avg_time_min: number | null; avg_distance_nm: number | null };

  // Fallback: get any route stats for these airports
  const fallbackStats = (!routeStats.avg_time_min)
    ? db.prepare(`
        SELECT ROUND(AVG(flight_time_min), 1) as avg_time_min,
               ROUND(AVG(distance_nm), 1) as avg_distance_nm
        FROM adsb_completed_legs
        WHERE origin_icao = ? AND destination_icao = ?
      `).get(origin, destination) as { avg_time_min: number | null; avg_distance_nm: number | null }
    : null;

  const timeMin = routeStats.avg_time_min ?? fallbackStats?.avg_time_min ?? null;
  const distNm = routeStats.avg_distance_nm ?? fallbackStats?.avg_distance_nm ?? null;

  const fuel = db.prepare(`
    SELECT avg_gph, avg_fuel_price_per_gallon FROM fuel_burn_estimates
    WHERE aircraft_class = ?
  `).get(aircraftClass) as { avg_gph: number; avg_fuel_price_per_gallon: number } | undefined;

  if (!fuel || !timeMin) {
    return {
      origin, destination, aircraftClass,
      error: !fuel ? "Unknown aircraft class" : "No flight data for this route",
    };
  }

  const flightHours = timeMin / 60;
  const gallons = Math.round(flightHours * fuel.avg_gph);
  const fuelCostCents = Math.round(gallons * fuel.avg_fuel_price_per_gallon * 100);

  return {
    origin, destination, aircraftClass,
    avgFlightTimeMin: timeMin,
    avgDistanceNm: distNm,
    estimatedGallons: gallons,
    gph: fuel.avg_gph,
    fuelPricePerGallon: fuel.avg_fuel_price_per_gallon,
    estimatedFuelCostCents: fuelCostCents,
    estimatedFuelCost: `$${(fuelCostCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeParseArray(json: string | null): string[] {
  if (!json) return [];
  try { return JSON.parse(json) as string[]; } catch { return []; }
}

function safeParseObj(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}
