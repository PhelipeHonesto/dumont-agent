/**
 * Shared Express middleware — auth, validation, async error handling.
 * Layer: server
 * Status: extracted for new endpoints. Not yet wired into existing routes.
 *
 * Adding a new endpoint should be a 10-line file, not a 40-line file.
 * These middleware extract the boilerplate.
 */

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";

// ── Auth Middleware ──────────────────────────────────────────────────────

const DUMONT_API_KEY = process.env.DUMONT_API_KEY;
const VAPI_SECRET = process.env.VAPI_SECRET;
const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Bearer token auth middleware. Checks DUMONT_API_KEY or VAPI_SECRET.
 * In dev without keys configured, requests pass through with a warning.
 * In production, unauthenticated requests get 401.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token && (token === DUMONT_API_KEY || token === VAPI_SECRET)) {
    next();
    return;
  }

  if (!DUMONT_API_KEY && !VAPI_SECRET) {
    if (IS_PROD) {
      res.status(401).json({ error: "Authentication required in production" });
      return;
    }
    next(); // Dev only
    return;
  }

  res.status(401).json({ error: "unauthorized" });
}

// ── Body Validation Middleware ───────────────────────────────────────────

/**
 * Zod-validates req.body against a schema. Returns 400 with error details on failure.
 * Usage: router.post("/endpoint", validateBody(MySchema), handler)
 */
export function validateBody<T>(schema: z.ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: "Validation failed",
        details: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
}

// ── Async Handler Wrapper ───────────────────────────────────────────────

/**
 * Wraps an async route handler with try/catch → next(err).
 * Usage: router.get("/endpoint", asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
