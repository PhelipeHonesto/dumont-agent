/**
 * Radar API — ADS-B fleet intelligence endpoints.
 * Layer: server
 *
 * GET /api/radar/stats  — fleet overview (airborne, idle, total)
 * GET /api/radar/ghost  — ghost positioning candidates near an origin
 */

import { Router } from "express";
import { authMiddleware, asyncHandler } from "../middleware.js";
import { KnowledgeGraphStore } from "../../memory/knowledge-graph.js";
import { getDb } from "../../memory/database.js";

export const radarRouter = Router();
radarRouter.use(authMiddleware);

// GET /api/radar/stats
radarRouter.get(
  "/api/radar/stats",
  asyncHandler(async (_req, res) => {
    const kg = new KnowledgeGraphStore(getDb());
    res.json(kg.getFleetStats());
  }),
);

// GET /api/radar/ghost?origin=KTEB&class=midsize
radarRouter.get(
  "/api/radar/ghost",
  asyncHandler(async (req, res) => {
    const origin = String(req.query.origin ?? "");
    const cls = String(req.query.class ?? "midsize");
    const maxHours = req.query.maxHours ? Number(req.query.maxHours) : undefined;

    if (!origin) {
      res.status(400).json({ error: "origin query parameter required" });
      return;
    }

    const kg = new KnowledgeGraphStore(getDb());
    const candidates = kg.getGhostCandidates(origin, cls, maxHours);
    res.json({
      origin,
      aircraftClass: cls,
      candidates,
      count: candidates.length,
    });
  }),
);
