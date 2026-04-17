/**
 * GET /health — cheap liveness probe (always OK if the event loop is alive).
 * GET /ready  — readiness probe: returns 503 if Postgres is unreachable.
 */

import { Router } from "express";
import { getPool } from "../../memory/pg-database.js";

const startedAt = Date.now();

export const healthRouter = Router();

healthRouter.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round((Date.now() - startedAt) / 1000),
    version: "0.1.0",
  });
});

healthRouter.get("/ready", async (_req, res) => {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    res.json({ status: "ready", note: "sqlite mode; pg check skipped" });
    return;
  }
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("pg timeout after 2s")), 2000),
  );
  try {
    await Promise.race([getPool().query("SELECT 1"), timeout]);
    res.json({ status: "ready" });
  } catch (err) {
    res.status(503).json({
      status: "not ready",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
});
