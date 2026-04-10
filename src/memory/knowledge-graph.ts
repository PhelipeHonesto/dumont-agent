/**
 * Knowledge Graph Store — FAA aircraft, operators, and airports.
 *
 * Provides typed queries over the faa_aircraft, faa_operators, and faa_airports tables.
 * Uses bounding-box + haversine for spatial airport queries.
 */

import type Database from "better-sqlite3";
import type { FaaAircraft, FaaOperator, FaaAirport } from "../schemas/knowledge-graph.js";
import { getDb } from "./database.js";
import { haversine } from "../utils/haversine.js";

// ── SQLite row interfaces ────────────────────────────────────────────────

interface AircraftRow {
  tail_number: string;
  serial_number: string | null;
  mfr_model_code: string | null;
  manufacturer: string | null;
  model: string | null;
  common_name: string | null;
  aircraft_class: string | null;
  year_manufactured: number | null;
  engine_type: string | null;
  num_engines: number | null;
  num_seats: number | null;
  owner_name: string | null;
  owner_city: string | null;
  owner_state: string | null;
  registrant_type: string | null;
  certificate_holder: string | null;
  certificate_number: string | null;
  status: string;
}

interface OperatorRow {
  certificate_number: string;
  name: string;
  dba_name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  aircraft_count: number;
  status: string;
}

interface AirportRow {
  icao_code: string;
  iata_code: string | null;
  faa_id: string | null;
  name: string;
  city: string | null;
  state: string | null;
  country: string;
  latitude: number;
  longitude: number;
  elevation_ft: number | null;
  longest_runway_ft: number | null;
  runway_surface: string | null;
  has_instrument_approach: number;
  fuel_types: string | null;
  tower_controlled: number;
  status: string;
}

interface CountRow {
  count: number;
}

export interface GhostCandidate {
  icaoHex: string;
  tailNumber: string | null;
  operatorName: string | null;
  aircraftClass: string | null;
  nearestAirport: string | null;
  idleHours: number;
  lastSeen: string;
}

export interface FleetStats {
  airborne: number;
  idleBase: number;
  idleTransient: number;
  total: number;
}

interface ClassCountRow {
  aircraft_class: string;
  count: number;
}

// ── Row mappers ──────────────────────────────────────────────────────────

function mapAircraft(row: AircraftRow): FaaAircraft {
  return {
    tailNumber: row.tail_number,
    serialNumber: row.serial_number,
    mfrModelCode: row.mfr_model_code,
    manufacturer: row.manufacturer,
    model: row.model,
    commonName: row.common_name,
    aircraftClass: row.aircraft_class,
    yearManufactured: row.year_manufactured,
    engineType: row.engine_type,
    numEngines: row.num_engines,
    numSeats: row.num_seats,
    ownerName: row.owner_name,
    ownerCity: row.owner_city,
    ownerState: row.owner_state,
    registrantType: row.registrant_type,
    certificateHolder: row.certificate_holder,
    certificateNumber: row.certificate_number,
    status: row.status,
  };
}

function mapOperator(row: OperatorRow): FaaOperator {
  return {
    certificateNumber: row.certificate_number,
    name: row.name,
    dbaName: row.dba_name,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    phone: row.phone,
    aircraftCount: row.aircraft_count,
    status: row.status,
  };
}

function mapAirport(row: AirportRow): FaaAirport {
  return {
    icaoCode: row.icao_code,
    iataCode: row.iata_code,
    faaId: row.faa_id,
    name: row.name,
    city: row.city,
    state: row.state,
    country: row.country,
    latitude: row.latitude,
    longitude: row.longitude,
    elevationFt: row.elevation_ft,
    longestRunwayFt: row.longest_runway_ft,
    runwaySurface: row.runway_surface,
    hasInstrumentApproach: row.has_instrument_approach === 1,
    fuelTypes: row.fuel_types,
    towerControlled: row.tower_controlled === 1,
    status: row.status,
  };
}

// ── Knowledge Graph Store ────────────────────────────────────────────────

export class KnowledgeGraphStore {
  private db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDb();
  }

  // ── Aircraft queries ─────────────────────────────────────────────────

  getAircraftByTail(tail: string): FaaAircraft | null {
    const row = this.db
      .prepare("SELECT * FROM faa_aircraft WHERE tail_number = ?")
      .get(tail.toUpperCase()) as AircraftRow | undefined;
    return row ? mapAircraft(row) : null;
  }

  getAircraftByClass(cls: string, limit = 100): FaaAircraft[] {
    const rows = this.db
      .prepare("SELECT * FROM faa_aircraft WHERE aircraft_class = ? LIMIT ?")
      .all(cls, limit) as AircraftRow[];
    return rows.map(mapAircraft);
  }

  getAircraftByOperator(certNumber: string): FaaAircraft[] {
    const rows = this.db
      .prepare("SELECT * FROM faa_aircraft WHERE certificate_number = ?")
      .all(certNumber) as AircraftRow[];
    return rows.map(mapAircraft);
  }

  searchAircraft(query: string, limit = 50): FaaAircraft[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM faa_aircraft
         WHERE tail_number LIKE ? OR common_name LIKE ? OR owner_name LIKE ?
         LIMIT ?`,
      )
      .all(like, like, like, limit) as AircraftRow[];
    return rows.map(mapAircraft);
  }

  getAircraftCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM faa_aircraft")
      .get() as CountRow;
    return row.count;
  }

  getClassBreakdown(): Record<string, number> {
    const rows = this.db
      .prepare(
        "SELECT aircraft_class, COUNT(*) as count FROM faa_aircraft WHERE aircraft_class IS NOT NULL GROUP BY aircraft_class",
      )
      .all() as ClassCountRow[];
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.aircraft_class] = row.count;
    }
    return result;
  }

  // ── Operator queries ─────────────────────────────────────────────────

  getOperator(certNumber: string): FaaOperator | null {
    const row = this.db
      .prepare("SELECT * FROM faa_operators WHERE certificate_number = ?")
      .get(certNumber) as OperatorRow | undefined;
    return row ? mapOperator(row) : null;
  }

  getOperatorByName(name: string): FaaOperator | null {
    const row = this.db
      .prepare("SELECT * FROM faa_operators WHERE name = ?")
      .get(name) as OperatorRow | undefined;
    return row ? mapOperator(row) : null;
  }

  searchOperators(query: string, limit = 50): FaaOperator[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM faa_operators
         WHERE name LIKE ? OR dba_name LIKE ? OR city LIKE ? OR state LIKE ?
         LIMIT ?`,
      )
      .all(like, like, like, like, limit) as OperatorRow[];
    return rows.map(mapOperator);
  }

  getAllOperators(): FaaOperator[] {
    const rows = this.db
      .prepare("SELECT * FROM faa_operators ORDER BY name")
      .all() as OperatorRow[];
    return rows.map(mapOperator);
  }

  // ── Airport queries ──────────────────────────────────────────────────

  getAirport(icao: string): FaaAirport | null {
    const row = this.db
      .prepare("SELECT * FROM faa_airports WHERE icao_code = ?")
      .get(icao.toUpperCase()) as AirportRow | undefined;
    return row ? mapAirport(row) : null;
  }

  getAirportsNear(
    lat: number,
    lon: number,
    radiusNm: number,
    limit = 20,
  ): (FaaAirport & { distanceNm: number })[] {
    // Rough bounding box: 1 degree lat ~ 60nm
    const degRange = radiusNm / 60;
    const rows = this.db
      .prepare(
        `SELECT * FROM faa_airports
         WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`,
      )
      .all(lat - degRange, lat + degRange, lon - degRange, lon + degRange) as AirportRow[];

    // Filter by actual haversine distance and sort
    const results: (FaaAirport & { distanceNm: number })[] = [];
    for (const row of rows) {
      const dist = haversine(lat, lon, row.latitude, row.longitude);
      if (dist <= radiusNm) {
        results.push({ ...mapAirport(row), distanceNm: Math.round(dist * 10) / 10 });
      }
    }
    results.sort((a, b) => a.distanceNm - b.distanceNm);
    return results.slice(0, limit);
  }

  getAirportsByState(state: string): FaaAirport[] {
    const rows = this.db
      .prepare("SELECT * FROM faa_airports WHERE state = ? ORDER BY name")
      .all(state.toUpperCase()) as AirportRow[];
    return rows.map(mapAirport);
  }

  getAirportCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM faa_airports")
      .get() as CountRow;
    return row.count;
  }

  // ── Cross-entity queries ─────────────────────────────────────────────

  getFleetAtAirport(icao: string, aircraftClass?: string): FaaAircraft[] {
    const airport = this.getAirport(icao);
    if (!airport || !airport.state) return [];

    let sql = "SELECT * FROM faa_aircraft WHERE owner_state = ?";
    const params: (string | number)[] = [airport.state];

    if (aircraftClass) {
      sql += " AND aircraft_class = ?";
      params.push(aircraftClass);
    }

    sql += " LIMIT 100";
    const rows = this.db.prepare(sql).all(...params) as AircraftRow[];
    return rows.map(mapAircraft);
  }

  getOperatorsInRadius(lat: number, lon: number, radiusNm: number): FaaOperator[] {
    // Get airports in radius, then find operators in those states
    const nearbyAirports = this.getAirportsNear(lat, lon, radiusNm, 100);
    const states = new Set(nearbyAirports.map((a) => a.state).filter(Boolean));
    if (states.size === 0) return [];

    const placeholders = [...states].map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM faa_operators WHERE state IN (${placeholders}) ORDER BY name`)
      .all(...states) as OperatorRow[];
    return rows.map(mapOperator);
  }

  getSummary(): {
    aircraftCount: number;
    operatorCount: number;
    airportCount: number;
    classCounts: Record<string, number>;
  } {
    return {
      aircraftCount: this.getAircraftCount(),
      operatorCount: (
        this.db.prepare("SELECT COUNT(*) as count FROM faa_operators").get() as CountRow
      ).count,
      airportCount: this.getAirportCount(),
      classCounts: this.getClassBreakdown(),
    };
  }

  // ── ADS-B / Ghost Positioning queries ─────────────────────────────────

  /**
   * Check whether the adsb_aircraft_state table has any rows.
   * Returns false if the table doesn't exist or is empty.
   */
  hasAdsbData(): boolean {
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) as count FROM adsb_aircraft_state")
        .get() as CountRow;
      return row.count > 0;
    } catch {
      return false;
    }
  }

  /**
   * Ghost candidates: aircraft idle at non-base airports near the given origin.
   * These are aircraft sitting away from home — operators may discount
   * empty-leg positioning if the trip takes the aircraft closer to base.
   */
  getGhostCandidates(
    originIcao: string,
    aircraftClass: string,
    maxIdleHours = 48,
  ): GhostCandidate[] {
    // Find the origin airport coordinates
    const origin = this.getAirport(originIcao);
    if (!origin) return [];

    // Get nearby airports (within 150nm) to form the candidate zone
    const nearbyAirports = this.getAirportsNear(
      origin.latitude,
      origin.longitude,
      150,
      200,
    );
    const nearbyIcaos = new Set(nearbyAirports.map((a) => a.icaoCode));

    try {
      const rows = this.db
        .prepare(
          `SELECT icao_hex, tail_number, operator_name, aircraft_class, nearest_airport,
                  idle_hours, last_seen
           FROM adsb_aircraft_state
           WHERE state = 'idle'
             AND aircraft_class = ?
             AND idle_hours <= ?
             AND idle_hours > 0
             AND nearest_airport IS NOT NULL
           ORDER BY idle_hours DESC`,
        )
        .all(aircraftClass, maxIdleHours) as {
        icao_hex: string;
        tail_number: string | null;
        operator_name: string | null;
        aircraft_class: string | null;
        nearest_airport: string | null;
        idle_hours: number;
        last_seen: string;
      }[];

      // Filter to candidates near the origin
      return rows
        .filter((r) => r.nearest_airport && nearbyIcaos.has(r.nearest_airport))
        .map((r) => ({
          icaoHex: r.icao_hex,
          tailNumber: r.tail_number,
          operatorName: r.operator_name,
          aircraftClass: r.aircraft_class,
          nearestAirport: r.nearest_airport,
          idleHours: Math.round(r.idle_hours * 10) / 10,
          lastSeen: r.last_seen,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Fleet stats for the Radar dashboard view.
   */
  getFleetStats(): FleetStats {
    try {
      const total = (
        this.db.prepare("SELECT COUNT(*) as count FROM adsb_aircraft_state").get() as CountRow
      ).count;
      const airborne = (
        this.db
          .prepare("SELECT COUNT(*) as count FROM adsb_aircraft_state WHERE state = 'airborne'")
          .get() as CountRow
      ).count;
      const idle = total - airborne;

      // Transient = idle but NOT at their operator's home base
      // For now, count all idle as transient since we don't have home base mapping yet
      // (future: join on operator_profiles.home_base)
      return { airborne, idleBase: 0, idleTransient: idle, total };
    } catch {
      return { airborne: 0, idleBase: 0, idleTransient: 0, total: 0 };
    }
  }
}
