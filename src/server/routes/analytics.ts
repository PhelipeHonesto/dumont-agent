/**
 * Analytics API — WINGX-equivalent market intelligence endpoints.
 * No auth required.
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
import { getDb } from "../../memory/database.js";
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

export const analyticsRouter = Router();

// ── GET /api/analytics/market ─────────────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/market",
  asyncHandler(async (req: Request, res: Response) => {
    const month = req.query.month ? String(req.query.month) : undefined;
    res.json(getMarketOverview(getDb(), month));
  }),
);

// ── GET /api/analytics/operator/:name ─────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/operator/:name",
  asyncHandler(async (req: Request, res: Response) => {
    const name = decodeURIComponent(String(req.params.name));
    const months = req.query.months ? Number(req.query.months) : 6;
    res.json(getOperatorProfile(getDb(), name, months));
  }),
);

// ── GET /api/analytics/airport/:icao ──────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/airport/:icao",
  asyncHandler(async (req: Request, res: Response) => {
    const icao = String(req.params.icao).toUpperCase();
    const date = req.query.date ? String(req.query.date) : undefined;
    res.json(getAirportReport(getDb(), icao, date));
  }),
);

// ── GET /api/analytics/route/:origin/:destination ─────────────────────────

analyticsRouter.get(
  "/api/analytics/route/:origin/:destination",
  asyncHandler(async (req: Request, res: Response) => {
    const origin = String(req.params.origin).toUpperCase();
    const destination = String(req.params.destination).toUpperCase();
    const months = req.query.months ? Number(req.query.months) : 12;
    res.json(getRouteTrend(getDb(), origin, destination, months));
  }),
);

// ── GET /api/analytics/fleet ──────────────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/fleet",
  asyncHandler(async (req: Request, res: Response) => {
    const cls = req.query.class ? String(req.query.class) : undefined;
    res.json(getFleetHealth(getDb(), cls));
  }),
);

// ── GET /api/analytics/top-routes ─────────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/top-routes",
  asyncHandler(async (req: Request, res: Response) => {
    const month = req.query.month ? String(req.query.month) : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 20;
    res.json(getTopRoutes(getDb(), month, limit));
  }),
);

// ── GET /api/analytics/top-operators ──────────────────────────────────────

analyticsRouter.get(
  "/api/analytics/top-operators",
  asyncHandler(async (req: Request, res: Response) => {
    const month = req.query.month ? String(req.query.month) : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 20;
    res.json(getTopOperators(getDb(), month, limit));
  }),
);

// ── GET /api/analytics/fuel/:origin/:destination/:class ───────────────────

analyticsRouter.get(
  "/api/analytics/fuel/:origin/:destination/:class",
  asyncHandler(async (req: Request, res: Response) => {
    const origin = String(req.params.origin).toUpperCase();
    const destination = String(req.params.destination).toUpperCase();
    const cls = String(req.params.class);
    res.json(getFuelEstimate(getDb(), origin, destination, cls));
  }),
);
