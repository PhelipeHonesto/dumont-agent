/**
 * GET /health — server health check.
 */

import { Router } from "express";

const startedAt = Date.now();

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round((Date.now() - startedAt) / 1000),
    version: "0.1.0",
  });
});
