/**
 * Analytics API — WINGX-equivalent market intelligence endpoints.
 * No auth required. Input validated.
 *
 * GET /api/analytics/market?month=2026-03
 * GET /api/analytics/operator/:name?months=6
 * GET /api/analytics/airport/:icao?date=2026-04-01
 * GET /api/analytics/route/:origin/:destination?months=12
 * GET /api/analytics/fleet?class=heavy
 * GET /api/analytics/top-routes?month=2026-03&limit=20
 * GET /api/analytics/top-operators?month=2026-03&limit=20
 * GET /api/analytics/fuel/:origin/:destination/:class
 */

import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../middleware.js";
import { getDatabase } from "../../memory/database.js";
import {
  getMarketOverview,
  getOperatorProfile,
  getAirportReport,
  getRouteTrend,
  getFleetHealth,
  getTopRoutes,
  getTopOperators,
  getFuelEstimate,
} from "../../analytics/wingx-queries.js";
import {
  validateIcaoCode, validateMonth, validateDate, validatePositiveInt,
  validateAircraftClass, sanitizeString, SanitizeError,
} from "../middleware/sanitize.js";

export const analyticsRouter = Router();

function handleSanitizeError(err: unknown, res: Response): boolean {
  if (err instanceof SanitizeError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

// ── GET /api/analytics/market ─────────────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/market",
  asyncHandler(async (req: Request, res: Response) => {
    let month: string | undefined;
    try { month = validateMonth(req.query.month); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    res.json(await getMarketOverview(getDatabase(), month));
  }),
);

// ── GET /api/analytics/operator/:name ─────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/operator/:name",
  asyncHandler(async (req: Request, res: Response) => {
    let name: string;
    try { name = sanitizeString(decodeURIComponent(String(req.params.name))); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const months = validatePositiveInt(req.query.months, 6, 24);
    res.json(await getOperatorProfile(getDatabase(), name, months));
  }),
);

// ── GET /api/analytics/airport/:icao ──────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/airport/:icao",
  asyncHandler(async (req: Request, res: Response) => {
    let icao: string;
    let date: string | undefined;
    try {
      icao = validateIcaoCode(req.params.icao);
      date = validateDate(req.query.date);
    } catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    res.json(await getAirportReport(getDatabase(), icao, date));
  }),
);

// ── GET /api/analytics/route/:origin/:destination ─────────────────────────

analyticsRouter.get(
  "/api/analytics/route/:origin/:destination",
  asyncHandler(async (req: Request, res: Response) => {
    let origin: string, destination: string;
    try {
      origin = validateIcaoCode(req.params.origin);
      destination = validateIcaoCode(req.params.destination);
    } catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const months = validatePositiveInt(req.query.months, 12, 60);
    res.json(await getRouteTrend(getDatabase(), origin, destination, months));
  }),
);

// ── GET /api/analytics/fleet ──────────────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/fleet",
  asyncHandler(async (req: Request, res: Response) => {
    let cls: string | undefined;
    try { cls = validateAircraftClass(req.query.class); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    res.json(await getFleetHealth(getDatabase(), cls));
  }),
);

// ── GET /api/analytics/top-routes ─────────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/top-routes",
  asyncHandler(async (req: Request, res: Response) => {
    let month: string | undefined;
    try { month = validateMonth(req.query.month); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const limit = validatePositiveInt(req.query.limit, 20, 100);
    res.json(await getTopRoutes(getDatabase(), month, limit));
  }),
);

// ── GET /api/analytics/top-operators ──────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/top-operators",
  asyncHandler(async (req: Request, res: Response) => {
    let month: string | undefined;
    try { month = validateMonth(req.query.month); }
    catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    const limit = validatePositiveInt(req.query.limit, 20, 100);
    res.json(await getTopOperators(getDatabase(), month, limit));
  }),
);

// ── GET /api/analytics/fuel/:origin/:destination/:class ───────────────────

analyticsRouter.get(
  "/api/analytics/fuel/:origin/:destination/:class",
  asyncHandler(async (req: Request, res: Response) => {
    let origin: string, destination: string, cls: string | undefined;
    try {
      origin = validateIcaoCode(req.params.origin);
      destination = validateIcaoCode(req.params.destination);
      cls = validateAircraftClass(req.params.class);
    } catch (e) { if (handleSanitizeError(e, res)) return; throw e; }
    if (!cls) {
      res.status(400).json({ error: "Aircraft class is required" });
      return;
    }
    res.json(await getFuelEstimate(getDatabase(), origin, destination, cls));
  }),
);
