/**
 * Lightweight error tracking — structured JSON to errors.log.
 *
 * No external dependencies. Keeps last ~1000 errors (rotates at 1MB).
 * GET /api/health/errors returns last 20 errors.
 */

import { appendFileSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import { childLogger } from "../../utils/logger.js";

const log = childLogger("error-tracker");

// ── Config ──────────────────────────────────────────────────────────────────

const LOG_PATH = resolve(process.env.ERROR_LOG_PATH ?? "./errors.log");
const MAX_SIZE = 1_048_576; // 1MB
const API_LIMIT = 20;

// ── Error entry ─────────────────────────────────────────────────────────────

interface ErrorEntry {
  timestamp: string;
  route: string;
  method: string;
  message: string;
  stack: string | null;
  ip: string | null;
}

// ── Log to file ─────────────────────────────────────────────────────────────

function rotateIfNeeded(): void {
  try {
    const stats = statSync(LOG_PATH);
    if (stats.size > MAX_SIZE) {
      // Keep the last half of the file
      const content = readFileSync(LOG_PATH, "utf-8");
      const lines = content.trim().split("\n");
      const keep = lines.slice(Math.floor(lines.length / 2));
      writeFileSync(LOG_PATH, keep.join("\n") + "\n");
    }
  } catch {
    // File doesn't exist yet — fine
  }
}

function logError(entry: ErrorEntry): void {
  try {
    rotateIfNeeded();
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch (err) {
    log.error({ err }, "failed to write error log");
  }
}

// ── Express error handler (mount as LAST middleware) ─────────────────────────

export function errorTracker(err: Error, req: Request, res: Response, _next: NextFunction): void {
  const entry: ErrorEntry = {
    timestamp: new Date().toISOString(),
    route: req.originalUrl || req.url,
    method: req.method,
    message: err.message,
    stack: err.stack?.split("\n").slice(0, 5).join("\n") ?? null,
    ip: req.ip ?? req.socket.remoteAddress ?? null,
  };

  logError(entry);
  log.error({ method: entry.method, route: entry.route, message: entry.message }, "request error");

  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── API endpoint ────────────────────────────────────────────────────────────

export const errorRouter = Router();

errorRouter.get("/api/health/errors", (_req: Request, res: Response) => {
  try {
    if (!existsSync(LOG_PATH)) {
      res.json({ errors: [], count: 0 });
      return;
    }

    const content = readFileSync(LOG_PATH, "utf-8").trim();
    if (!content) {
      res.json({ errors: [], count: 0 });
      return;
    }

    const lines = content.split("\n");
    const recent = lines.slice(-API_LIMIT).reverse();
    const errors: ErrorEntry[] = [];

    for (const line of recent) {
      try {
        errors.push(JSON.parse(line) as ErrorEntry);
      } catch {
        // skip malformed lines
      }
    }

    res.json({ errors, count: lines.length });
  } catch {
    res.json({ errors: [], count: 0, error: "Failed to read error log" });
  }
});
