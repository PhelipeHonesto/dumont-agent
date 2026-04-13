/**
 * Dumont MCP Server — Model Context Protocol interface to aviation intelligence.
 *
 * Exposes 9 tools that query the SQLite database directly (no HTTP).
 * Designed for stdio transport — connect via Claude Desktop or any MCP client.
 *
 * Usage: npx tsx src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb, closeDb } from "../memory/database.js";
import { KnowledgeGraphStore } from "../memory/knowledge-graph.js";
import { getDataHealth, getFeedHealth } from "../monitoring/health-queries.js";

// ── Helpers (mirrored from intelligence.ts) ─────────────────────────────

function clampLimit(raw: number | undefined, defaultVal = 50, max = 200): number {
  if (raw == null || !Number.isFinite(raw) || raw < 1) return defaultVal;
  return Math.min(raw, max);
}

// ── Server setup ────────────────────────────────────────────────────────

const server = new McpServer(
  {
    name: "dumont-intelligence",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
    instructions:
      "Dumont Aviation Intelligence — query FAA registry, ADS-B flight data, " +
      "ghost fleet candidates, market listings, and route analytics for US " +
      "charter-class aircraft.",
  },
);

// ── Tool: lookup_aircraft ───────────────────────────────────────────────

server.tool(
  "lookup_aircraft",
  "Look up full aircraft profile by tail number. Returns FAA registration, " +
    "owner, operator, ADS-B state, flight stats, lien history, linked pilots, " +
    "and ghost candidate status.",
  { tail_number: z.string().describe("US tail number, e.g. N123AB") },
  async ({ tail_number }) => {
    const tail = tail_number.toUpperCase();
    const db = getDb();

    const aircraft = db
      .prepare(`SELECT * FROM faa_aircraft WHERE tail_number = ?`)
      .get(tail) as Record<string, unknown> | undefined;

    if (!aircraft) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Aircraft not found", tailNumber: tail }) }] };
    }

    const adsbState = aircraft.icao_hex
      ? (db
          .prepare(
            `SELECT state, nearest_airport, idle_hours, last_seen,
                    last_leg_origin, last_leg_destination, latitude, longitude
             FROM adsb_aircraft_state WHERE icao_hex = ?`,
          )
          .get(aircraft.icao_hex as string) as Record<string, unknown> | undefined)
      : null;

    const flightStats = db
      .prepare(
        `SELECT COUNT(*) as total_legs,
                MIN(departure_time) as earliest_flight,
                MAX(departure_time) as latest_flight,
                ROUND(AVG(flight_time_min), 1) as avg_flight_time_min,
                ROUND(SUM(distance_nm), 1) as total_distance_nm
         FROM adsb_completed_legs WHERE tail_number = ?`,
      )
      .get(tail) as Record<string, unknown>;

    const liens = db
      .prepare(
        `SELECT doc_type, party_name, receipt_date, doc_id
         FROM faa_docindex WHERE tail_number = ?
         ORDER BY receipt_date DESC LIMIT 20`,
      )
      .all(tail) as Array<Record<string, unknown>>;

    const pilots = db
      .prepare(
        `SELECT p.certificate_number, p.first_middle_name, p.last_name,
                p.city, p.state, p.medical_class,
                l.match_type, l.aircraft_base_icao
         FROM pilot_aircraft_link l
         JOIN pilot_contacts p ON l.certificate_number = p.certificate_number
         WHERE l.tail_number = ?
         LIMIT 20`,
      )
      .all(tail) as Array<Record<string, unknown>>;

    const isGhost =
      adsbState &&
      (adsbState.state === "idle_transient" || adsbState.state === "idle") &&
      (adsbState.idle_hours as number) >= 6;

    const result = {
      tailNumber: tail,
      registration: {
        serialNumber: aircraft.serial_number,
        manufacturer: aircraft.manufacturer,
        model: aircraft.model,
        commonName: aircraft.common_name,
        aircraftClass: aircraft.aircraft_class,
        yearManufactured: aircraft.year_manufactured,
        engineType: aircraft.engine_type,
        numEngines: aircraft.num_engines,
        numSeats: aircraft.num_seats,
        status: aircraft.status,
        icaoHex: aircraft.icao_hex,
      },
      owner: {
        name: aircraft.owner_name,
        city: aircraft.owner_city,
        state: aircraft.owner_state,
        registrantType: aircraft.registrant_type,
      },
      operator: {
        certificateHolder: aircraft.certificate_holder,
        certificateNumber: aircraft.certificate_number,
      },
      adsbState: adsbState
        ? {
            state: adsbState.state,
            nearestAirport: adsbState.nearest_airport,
            idleHours: adsbState.idle_hours,
            lastSeen: adsbState.last_seen,
            lastLegOrigin: adsbState.last_leg_origin,
            lastLegDestination: adsbState.last_leg_destination,
            latitude: adsbState.latitude,
            longitude: adsbState.longitude,
          }
        : null,
      flightStats: {
        totalLegs: flightStats.total_legs,
        earliestFlight: flightStats.earliest_flight,
        latestFlight: flightStats.latest_flight,
        avgFlightTimeMin: flightStats.avg_flight_time_min,
        totalDistanceNm: flightStats.total_distance_nm,
      },
      liens: liens.map((l) => ({
        docType: l.doc_type,
        partyName: l.party_name,
        receiptDate: l.receipt_date,
        docId: l.doc_id,
      })),
      linkedPilots: pilots.map((p) => ({
        certificateNumber: p.certificate_number,
        name: `${p.first_middle_name ?? ""} ${p.last_name ?? ""}`.trim(),
        city: p.city,
        state: p.state,
        medicalClass: p.medical_class,
        matchType: p.match_type,
        baseAirport: p.aircraft_base_icao,
      })),
      ghostCandidate: isGhost
        ? { isGhost: true, airport: adsbState!.nearest_airport, idleHours: adsbState!.idle_hours }
        : { isGhost: false },
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: get_flights ───────────────────────────────────────────────────

server.tool(
  "get_flights",
  "Get flight history for an aircraft by tail number. Returns completed legs " +
    "with origin, destination, times, and distances.",
  {
    tail_number: z.string().describe("US tail number, e.g. N123AB"),
    limit: z.number().optional().describe("Max results (default 50, max 200)"),
  },
  async ({ tail_number, limit: rawLimit }) => {
    const tail = tail_number.toUpperCase();
    const limit = clampLimit(rawLimit);
    const db = getDb();

    const aircraft = db
      .prepare(`SELECT icao_hex FROM faa_aircraft WHERE tail_number = ?`)
      .get(tail) as { icao_hex: string | null } | undefined;

    if (!aircraft) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Aircraft not found", tailNumber: tail }) }] };
    }

    const legs = db
      .prepare(
        `SELECT origin_icao, destination_icao, departure_time, arrival_time,
                flight_time_min, distance_nm, aircraft_type, aircraft_class
         FROM adsb_completed_legs
         WHERE tail_number = ? OR icao_hex = ?
         ORDER BY departure_time DESC
         LIMIT ?`,
      )
      .all(tail, aircraft.icao_hex ?? "", limit) as Array<Record<string, unknown>>;

    const total = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM adsb_completed_legs
         WHERE tail_number = ? OR icao_hex = ?`,
      )
      .get(tail, aircraft.icao_hex ?? "") as { cnt: number };

    const result = {
      tailNumber: tail,
      flights: legs.map((l) => ({
        origin: l.origin_icao,
        destination: l.destination_icao,
        departureTime: l.departure_time,
        arrivalTime: l.arrival_time,
        flightTimeMin: l.flight_time_min,
        distanceNm: l.distance_nm,
        aircraftType: l.aircraft_type,
        aircraftClass: l.aircraft_class,
      })),
      total: total.cnt,
      limit,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: find_ghosts ───────────────────────────────────────────────────

server.tool(
  "find_ghosts",
  "Find ghost fleet candidates near an airport — charter aircraft sitting idle " +
    "away from their home base. Operators may discount empty-leg positioning.",
  {
    airport_icao: z.string().describe("Airport ICAO code, e.g. KORD"),
  },
  async ({ airport_icao }) => {
    const icao = airport_icao.toUpperCase();
    const db = getDb();
    const kg = new KnowledgeGraphStore(db);

    const classes = ["light", "midsize", "super_mid", "heavy", "turboprop"];
    const allCandidates: Array<Record<string, unknown>> = [];

    for (const cls of classes) {
      const candidates = kg.getGhostCandidates(icao, cls);
      for (const c of candidates) {
        allCandidates.push({ ...c, searchClass: cls });
      }
    }

    const seen = new Set<string>();
    const unique = allCandidates.filter((c) => {
      const tail = String(c.tailNumber ?? c.tail_number ?? "");
      if (seen.has(tail)) return false;
      seen.add(tail);
      return true;
    });

    const result = { airport: icao, candidates: unique, count: unique.length };
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: fleet_stats ───────────────────────────────────────────────────

server.tool(
  "fleet_stats",
  "Get fleet intelligence summary — total tracked aircraft, airborne vs idle, " +
    "ghost candidates, breakdown by class, and top ghost airports.",
  {},
  async () => {
    const db = getDb();
    const kg = new KnowledgeGraphStore(db);
    const fleetStats = kg.getFleetStats();

    const byClass = db
      .prepare(
        `SELECT aircraft_class, COUNT(*) as count
         FROM adsb_aircraft_state
         WHERE aircraft_class IS NOT NULL
         GROUP BY aircraft_class
         ORDER BY count DESC`,
      )
      .all() as Array<{ aircraft_class: string; count: number }>;

    const registryTotal = db
      .prepare(`SELECT COUNT(*) as cnt FROM faa_aircraft`)
      .get() as { cnt: number };

    const ghostCount = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM adsb_aircraft_state
         WHERE state = 'idle_transient' AND idle_hours >= 6`,
      )
      .get() as { cnt: number };

    const topGhostAirports = db
      .prepare(
        `SELECT nearest_airport, COUNT(*) as count
         FROM adsb_aircraft_state
         WHERE state = 'idle_transient' AND idle_hours >= 6
           AND nearest_airport IS NOT NULL
         GROUP BY nearest_airport
         ORDER BY count DESC
         LIMIT 15`,
      )
      .all() as Array<{ nearest_airport: string; count: number }>;

    const result = {
      adsbTracked: {
        total: fleetStats.total,
        airborne: fleetStats.airborne,
        idleBase: fleetStats.idleBase,
        idleTransient: fleetStats.idleTransient,
      },
      registryTotal: registryTotal.cnt,
      ghostCandidates: ghostCount.cnt,
      byClass: byClass.map((r) => ({ aircraftClass: r.aircraft_class, count: r.count })),
      topGhostAirports: topGhostAirports.map((r) => ({ airport: r.nearest_airport, count: r.count })),
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: route_intel ───────────────────────────────────────────────────

server.tool(
  "route_intel",
  "Get route intelligence between two airports — flight frequency, avg flight time, " +
    "aircraft class breakdown, busiest days, and monthly trend.",
  {
    origin: z.string().describe("Origin airport ICAO code, e.g. KTEB"),
    destination: z.string().describe("Destination airport ICAO code, e.g. KPBI"),
  },
  async ({ origin: rawOrigin, destination: rawDest }) => {
    const origin = rawOrigin.toUpperCase();
    const destination = rawDest.toUpperCase();
    const db = getDb();

    const stats = db
      .prepare(
        `SELECT COUNT(*) as total_flights,
                ROUND(AVG(flight_time_min), 1) as avg_flight_time_min,
                ROUND(MIN(flight_time_min), 1) as min_flight_time_min,
                ROUND(MAX(flight_time_min), 1) as max_flight_time_min,
                ROUND(AVG(distance_nm), 1) as avg_distance_nm
         FROM adsb_completed_legs
         WHERE origin_icao = ? AND destination_icao = ?`,
      )
      .get(origin, destination) as Record<string, unknown>;

    const byClass = db
      .prepare(
        `SELECT aircraft_class, COUNT(*) as count
         FROM adsb_completed_legs
         WHERE origin_icao = ? AND destination_icao = ?
           AND aircraft_class IS NOT NULL
         GROUP BY aircraft_class
         ORDER BY count DESC`,
      )
      .all(origin, destination) as Array<{ aircraft_class: string; count: number }>;

    const byDay = db
      .prepare(
        `SELECT CAST(strftime('%w', departure_time) AS INTEGER) as day_of_week,
                COUNT(*) as count
         FROM adsb_completed_legs
         WHERE origin_icao = ? AND destination_icao = ?
         GROUP BY day_of_week
         ORDER BY count DESC`,
      )
      .all(origin, destination) as Array<{ day_of_week: number; count: number }>;

    const monthlyTrend = db
      .prepare(
        `SELECT strftime('%Y-%m', departure_time) as month, COUNT(*) as count
         FROM adsb_completed_legs
         WHERE origin_icao = ? AND destination_icao = ?
           AND departure_time >= datetime('now', '-12 months')
         GROUP BY month
         ORDER BY month`,
      )
      .all(origin, destination) as Array<{ month: string; count: number }>;

    const totalFlights = (stats.total_flights as number) ?? 0;
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const result = {
      route: { origin, destination },
      totalFlights,
      avgFlightTimeMin: stats.avg_flight_time_min,
      minFlightTimeMin: stats.min_flight_time_min,
      maxFlightTimeMin: stats.max_flight_time_min,
      avgDistanceNm: stats.avg_distance_nm,
      aircraftClasses: byClass.map((r) => ({
        aircraftClass: r.aircraft_class,
        count: r.count,
        pct: totalFlights > 0 ? Math.round((r.count / totalFlights) * 1000) / 10 : 0,
      })),
      busiestDays: byDay.map((r) => ({
        dayOfWeek: r.day_of_week,
        dayName: dayNames[r.day_of_week] ?? "?",
        count: r.count,
      })),
      monthlyTrend,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: active_listings ───────────────────────────────────────────────

server.tool(
  "active_listings",
  "Get active aircraft-for-sale listings. Filter by aircraft type. " +
    "Returns tail number, price, type, days on market.",
  {
    aircraft_type: z.string().optional().describe("Filter by aircraft type, e.g. 'Citation Latitude'"),
    limit: z.number().optional().describe("Max results (default 50, max 200)"),
  },
  async ({ aircraft_type, limit: rawLimit }) => {
    const limit = clampLimit(rawLimit);
    const db = getDb();

    let query: string;
    let params: unknown[];

    if (aircraft_type) {
      query = `SELECT tail_number, source, listing_url, asking_price_cents, currency,
                      aircraft_type, year, first_seen_at, last_seen_at, status, days_on_market
               FROM aircraft_listings
               WHERE status = 'active' AND aircraft_type LIKE ?
               ORDER BY days_on_market DESC
               LIMIT ?`;
      params = [`%${aircraft_type}%`, limit];
    } else {
      query = `SELECT tail_number, source, listing_url, asking_price_cents, currency,
                      aircraft_type, year, first_seen_at, last_seen_at, status, days_on_market
               FROM aircraft_listings
               WHERE status = 'active'
               ORDER BY days_on_market DESC
               LIMIT ?`;
      params = [limit];
    }

    const listings = db.prepare(query).all(...params) as Array<Record<string, unknown>>;

    const total = db
      .prepare(`SELECT COUNT(*) as cnt FROM aircraft_listings WHERE status = 'active'`)
      .get() as { cnt: number };

    const result = {
      listings: listings.map((l) => ({
        tailNumber: l.tail_number,
        source: l.source,
        listingUrl: l.listing_url,
        askingPriceCents: l.asking_price_cents,
        currency: l.currency,
        aircraftType: l.aircraft_type,
        year: l.year,
        firstSeenAt: l.first_seen_at,
        lastSeenAt: l.last_seen_at,
        status: l.status,
        daysOnMarket: l.days_on_market,
      })),
      total: total.cnt,
      limit,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: recent_transactions ───────────────────────────────────────────

server.tool(
  "recent_transactions",
  "Get recent FAA registry ownership changes — aircraft sales, transfers, " +
    "and registration updates.",
  {
    limit: z.number().optional().describe("Max results (default 50, max 200)"),
  },
  async ({ limit: rawLimit }) => {
    const limit = clampLimit(rawLimit);
    const db = getDb();

    const changes = db
      .prepare(
        `SELECT r.tail_number, r.change_type, r.field_name,
                r.old_value, r.new_value, r.detected_at,
                a.aircraft_class, a.common_name, a.manufacturer, a.model
         FROM faa_registry_changes r
         LEFT JOIN faa_aircraft a ON r.tail_number = a.tail_number
         ORDER BY r.detected_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    const total = db
      .prepare(`SELECT COUNT(*) as cnt FROM faa_registry_changes`)
      .get() as { cnt: number };

    const result = {
      transactions: changes.map((c) => ({
        tailNumber: c.tail_number,
        changeType: c.change_type,
        fieldName: c.field_name,
        oldValue: c.old_value,
        newValue: c.new_value,
        detectedAt: c.detected_at,
        aircraftClass: c.aircraft_class,
        commonName: c.common_name,
        manufacturer: c.manufacturer,
        model: c.model,
      })),
      total: total.cnt,
      limit,
    };

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: data_health ───────────────────────────────────────────────────

server.tool(
  "data_health",
  "Check data freshness across all sources — pipeline, ADS-B feed, FAA registry, " +
    "knowledge graph. Returns traffic-light status (green/yellow/red).",
  {},
  async () => {
    const health = getDataHealth(getDb());
    return { content: [{ type: "text" as const, text: JSON.stringify(health, null, 2) }] };
  },
);

// ── Tool: feed_health ───────────────────────────────────────────────────

server.tool(
  "feed_health",
  "Check ADS-B feed health — is the live position feed alive, stale, or dead? " +
    "Returns positions/hour, legs today, latest position age.",
  {},
  async () => {
    const feed = getFeedHealth(getDb());
    return { content: [{ type: "text" as const, text: JSON.stringify(feed, null, 2) }] };
  },
);

// ── Start ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    closeDb();
    await server.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    closeDb();
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
