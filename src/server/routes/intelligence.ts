/**
 * Intelligence API — public fleet, market, and route intelligence endpoints.
 * No auth required — powers route pages, SEO, and the dashboard.
 *
 * GET /api/aircraft/:tailNumber          — full aircraft profile
 * GET /api/aircraft/:tailNumber/flights  — flight history
 * GET /api/airport/:icao/ghosts          — ghost candidates at airport
 * GET /api/fleet/stats                   — fleet intelligence summary
 * GET /api/routes/:origin/:destination   — route intelligence
 * GET /api/market/listings               — active aircraft listings
 * GET /api/market/transactions           — recent ownership changes
 */

import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware.js";
import { getDb } from "../../memory/database.js";
import { KnowledgeGraphStore } from "../../memory/knowledge-graph.js";
import { getDataHealth, getFeedHealth } from "../../monitoring/health-queries.js";
import {
  validateTailNumber, validateIcaoCode, validatePositiveInt,
  sanitizeString, SanitizeError,
} from "../middleware/sanitize.js";

export const intelligenceRouter = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

function clampOffset(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// Catch SanitizeError and return 400
function handleSanitizeError(err: unknown, res: Response): boolean {
  if (err instanceof SanitizeError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

// ── GET /api/aircraft/:tailNumber ──────────────────────────────────────────

intelligenceRouter.get(
  "/api/aircraft/:tailNumber",
  asyncHandler(async (req: Request, res: Response) => {
    let tail: string;
    try { tail = validateTailNumber(req.params.tailNumber); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const db = getDb();

    // Core registration
    const aircraft = db.prepare(
      `SELECT * FROM faa_aircraft WHERE tail_number = ?`,
    ).get(tail) as Record<string, unknown> | undefined;

    if (!aircraft) {
      res.status(404).json({ error: "Aircraft not found", tailNumber: tail });
      return;
    }

    // ADS-B state
    const adsbState = aircraft.icao_hex
      ? db.prepare(
          `SELECT state, nearest_airport, idle_hours, last_seen,
                  last_leg_origin, last_leg_destination, latitude, longitude
           FROM adsb_aircraft_state WHERE icao_hex = ?`,
        ).get(aircraft.icao_hex as string) as Record<string, unknown> | undefined
      : null;

    // Flight stats from completed legs
    const flightStats = db.prepare(
      `SELECT COUNT(*) as total_legs,
              MIN(departure_time) as earliest_flight,
              MAX(departure_time) as latest_flight,
              ROUND(AVG(flight_time_min), 1) as avg_flight_time_min,
              ROUND(SUM(distance_nm), 1) as total_distance_nm
       FROM adsb_completed_legs WHERE tail_number = ?`,
    ).get(tail) as Record<string, unknown>;

    // Lien history from docindex
    const liens = db.prepare(
      `SELECT doc_type, party_name, receipt_date, doc_id
       FROM faa_docindex WHERE tail_number = ?
       ORDER BY receipt_date DESC LIMIT 20`,
    ).all(tail) as Array<Record<string, unknown>>;

    // Linked pilots
    const pilots = db.prepare(
      `SELECT p.certificate_number, p.first_middle_name, p.last_name,
              p.city, p.state, p.medical_class,
              l.match_type, l.aircraft_base_icao
       FROM pilot_aircraft_link l
       JOIN pilot_contacts p ON l.certificate_number = p.certificate_number
       WHERE l.tail_number = ?
       LIMIT 20`,
    ).all(tail) as Array<Record<string, unknown>>;

    // Ghost status: is it idle at an airport?
    const isGhost = adsbState
      && (adsbState.state === "idle_transient" || adsbState.state === "idle")
      && (adsbState.idle_hours as number) >= 6;

    res.json({
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
        ? {
            isGhost: true,
            airport: adsbState!.nearest_airport,
            idleHours: adsbState!.idle_hours,
          }
        : { isGhost: false },
    });
  }),
);

// ── GET /api/aircraft/:tailNumber/flights ──────────────────────────────────

intelligenceRouter.get(
  "/api/aircraft/:tailNumber/flights",
  asyncHandler(async (req: Request, res: Response) => {
    let tail: string;
    try { tail = validateTailNumber(req.params.tailNumber); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const limit = validatePositiveInt(req.query.limit, 50, 200);
    const offset = clampOffset(req.query.offset);
    const db = getDb();

    // Look up icao_hex for this tail
    const aircraft = db.prepare(
      `SELECT icao_hex FROM faa_aircraft WHERE tail_number = ?`,
    ).get(tail) as { icao_hex: string | null } | undefined;

    if (!aircraft) {
      res.status(404).json({ error: "Aircraft not found", tailNumber: tail });
      return;
    }

    // Query by tail_number directly (completed_legs has both)
    const legs = db.prepare(
      `SELECT origin_icao, destination_icao, departure_time, arrival_time,
              flight_time_min, distance_nm, aircraft_type, aircraft_class
       FROM adsb_completed_legs
       WHERE tail_number = ? OR icao_hex = ?
       ORDER BY departure_time DESC
       LIMIT ? OFFSET ?`,
    ).all(tail, aircraft.icao_hex ?? "", limit, offset) as Array<Record<string, unknown>>;

    const total = db.prepare(
      `SELECT COUNT(*) as cnt FROM adsb_completed_legs
       WHERE tail_number = ? OR icao_hex = ?`,
    ).get(tail, aircraft.icao_hex ?? "") as { cnt: number };

    res.json({
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
      offset,
    });
  }),
);

// ── GET /api/airport/:icao/ghosts ──────────────────────────────────────────

intelligenceRouter.get(
  "/api/airport/:icao/ghosts",
  asyncHandler(async (req: Request, res: Response) => {
    let icao: string;
    try { icao = validateIcaoCode(req.params.icao); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const aircraftClass = String(req.query.class ?? "");
    const maxHours = req.query.maxHours ? Number(req.query.maxHours) : undefined;
    const db = getDb();

    const kg = new KnowledgeGraphStore(db);

    // If no class specified, search all common charter classes
    const classes = aircraftClass
      ? [aircraftClass]
      : ["light", "midsize", "super_mid", "heavy", "turboprop"];

    const allCandidates: Array<Record<string, unknown>> = [];

    for (const cls of classes) {
      const candidates = kg.getGhostCandidates(icao, cls, maxHours);
      for (const c of candidates) {
        allCandidates.push({ ...c, searchClass: cls });
      }
    }

    // Deduplicate by tail number
    const seen = new Set<string>();
    const unique = allCandidates.filter((c) => {
      const tail = String(c.tailNumber ?? c.tail_number ?? "");
      if (seen.has(tail)) return false;
      seen.add(tail);
      return true;
    });

    res.json({
      airport: icao,
      candidates: unique,
      count: unique.length,
    });
  }),
);

// ── GET /api/fleet/stats ───────────────────────────────────────────────────

intelligenceRouter.get(
  "/api/fleet/stats",
  asyncHandler(async (_req: Request, res: Response) => {
    const db = getDb();
    const kg = new KnowledgeGraphStore(db);
    const fleetStats = kg.getFleetStats();

    // By class breakdown
    const byClass = db.prepare(
      `SELECT aircraft_class, COUNT(*) as count
       FROM adsb_aircraft_state
       WHERE aircraft_class IS NOT NULL
       GROUP BY aircraft_class
       ORDER BY count DESC`,
    ).all() as Array<{ aircraft_class: string; count: number }>;

    // Total tracked in registry
    const registryTotal = db.prepare(
      `SELECT COUNT(*) as cnt FROM faa_aircraft`,
    ).get() as { cnt: number };

    // Ghost candidates (idle_transient with significant idle time)
    const ghostCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM adsb_aircraft_state
       WHERE state = 'idle_transient' AND idle_hours >= 6`,
    ).get() as { cnt: number };

    // Top ghost airports
    const topGhostAirports = db.prepare(
      `SELECT nearest_airport, COUNT(*) as count
       FROM adsb_aircraft_state
       WHERE state = 'idle_transient' AND idle_hours >= 6
         AND nearest_airport IS NOT NULL
       GROUP BY nearest_airport
       ORDER BY count DESC
       LIMIT 15`,
    ).all() as Array<{ nearest_airport: string; count: number }>;

    res.json({
      adsbTracked: {
        total: fleetStats.total,
        airborne: fleetStats.airborne,
        idleBase: fleetStats.idleBase,
        idleTransient: fleetStats.idleTransient,
      },
      registryTotal: registryTotal.cnt,
      ghostCandidates: ghostCount.cnt,
      byClass: byClass.map((r) => ({
        aircraftClass: r.aircraft_class,
        count: r.count,
      })),
      topGhostAirports: topGhostAirports.map((r) => ({
        airport: r.nearest_airport,
        count: r.count,
      })),
    });
  }),
);

// ── GET /api/routes/:origin/:destination ───────────────────────────────────

intelligenceRouter.get(
  "/api/routes/:origin/:destination",
  asyncHandler(async (req: Request, res: Response) => {
    let origin: string, destination: string;
    try {
      origin = validateIcaoCode(req.params.origin);
      destination = validateIcaoCode(req.params.destination);
    } catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const db = getDb();

    // Frequency and timing
    const stats = db.prepare(
      `SELECT COUNT(*) as total_flights,
              ROUND(AVG(flight_time_min), 1) as avg_flight_time_min,
              ROUND(MIN(flight_time_min), 1) as min_flight_time_min,
              ROUND(MAX(flight_time_min), 1) as max_flight_time_min,
              ROUND(AVG(distance_nm), 1) as avg_distance_nm
       FROM adsb_completed_legs
       WHERE origin_icao = ? AND destination_icao = ?`,
    ).get(origin, destination) as Record<string, unknown>;

    // Most common aircraft classes
    const byClass = db.prepare(
      `SELECT aircraft_class, COUNT(*) as count
       FROM adsb_completed_legs
       WHERE origin_icao = ? AND destination_icao = ?
         AND aircraft_class IS NOT NULL
       GROUP BY aircraft_class
       ORDER BY count DESC`,
    ).all(origin, destination) as Array<{ aircraft_class: string; count: number }>;

    // Busiest days of week (0=Sunday)
    const byDay = db.prepare(
      `SELECT CAST(strftime('%w', departure_time) AS INTEGER) as day_of_week,
              COUNT(*) as count
       FROM adsb_completed_legs
       WHERE origin_icao = ? AND destination_icao = ?
       GROUP BY day_of_week
       ORDER BY count DESC`,
    ).all(origin, destination) as Array<{ day_of_week: number; count: number }>;

    // Monthly trend (last 12 months)
    const monthlyTrend = db.prepare(
      `SELECT strftime('%Y-%m', departure_time) as month, COUNT(*) as count
       FROM adsb_completed_legs
       WHERE origin_icao = ? AND destination_icao = ?
         AND departure_time >= datetime('now', '-12 months')
       GROUP BY month
       ORDER BY month`,
    ).all(origin, destination) as Array<{ month: string; count: number }>;

    const totalFlights = (stats.total_flights as number) ?? 0;

    res.json({
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
        dayName: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][r.day_of_week],
        count: r.count,
      })),
      monthlyTrend,
    });
  }),
);

// ── GET /api/market/listings ───────────────────────────────────────────────

intelligenceRouter.get(
  "/api/market/listings",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = validatePositiveInt(req.query.limit, 50, 200);
    const offset = clampOffset(req.query.offset);
    let status: string;
    try { status = sanitizeString(req.query.status ?? "active", 20); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const db = getDb();

    const listings = db.prepare(
      `SELECT tail_number, source, listing_url, asking_price_cents, currency,
              aircraft_type, year, description, first_seen_at, last_seen_at,
              status, days_on_market
       FROM aircraft_listings
       WHERE status = ?
       ORDER BY days_on_market DESC
       LIMIT ? OFFSET ?`,
    ).all(status, limit, offset) as Array<Record<string, unknown>>;

    const total = db.prepare(
      `SELECT COUNT(*) as cnt FROM aircraft_listings WHERE status = ?`,
    ).get(status) as { cnt: number };

    res.json({
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
      offset,
    });
  }),
);

// ── GET /api/market/transactions ───────────────────────────────────────────

intelligenceRouter.get(
  "/api/market/transactions",
  asyncHandler(async (req: Request, res: Response) => {
    const limit = validatePositiveInt(req.query.limit, 50, 200);
    const offset = clampOffset(req.query.offset);
    const db = getDb();

    const changes = db.prepare(
      `SELECT r.tail_number, r.change_type, r.field_name,
              r.old_value, r.new_value, r.detected_at,
              a.aircraft_class, a.common_name, a.manufacturer, a.model
       FROM faa_registry_changes r
       LEFT JOIN faa_aircraft a ON r.tail_number = a.tail_number
       ORDER BY r.detected_at DESC
       LIMIT ? OFFSET ?`,
    ).all(limit, offset) as Array<Record<string, unknown>>;

    const total = db.prepare(
      `SELECT COUNT(*) as cnt FROM faa_registry_changes`,
    ).get() as { cnt: number };

    res.json({
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
      offset,
    });
  }),
);

// ── GET /api/health/data ───────────────────────────────────────────────────

intelligenceRouter.get(
  "/api/health/data",
  asyncHandler(async (_req: Request, res: Response) => {
    const health = getDataHealth(getDb());
    const statusCode = health.overall === "red" ? 503 : 200;
    res.status(statusCode).json(health);
  }),
);

// ── GET /api/health/feed ───────────────────────────────────────────────────

intelligenceRouter.get(
  "/api/health/feed",
  asyncHandler(async (_req: Request, res: Response) => {
    const feed = getFeedHealth(getDb());
    const statusCode = feed.feedStatus === "dead" ? 503 : 200;
    res.status(statusCode).json(feed);
  }),
);
