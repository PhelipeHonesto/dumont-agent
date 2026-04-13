/**
 * Rate limiting middleware.
 *
 * - Global: 100 req/min per IP
 * - Heavy (analytics, routes, market): 10 req/min per IP
 * - Health endpoints: exempt
 */

import rateLimit from "express-rate-limit";

/** Global rate limit: 100 requests per minute per IP. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests — try again later" },
  handler: (_req, res, _next, options) => {
    console.warn(`[rate-limit] Global limit hit: ${_req.ip}`);
    res.status(429).json(options.message);
  },
  skip: (req) => {
    // Exempt health endpoints
    const path = req.path;
    return path === "/health" || path.startsWith("/api/health");
  },
});

/** Heavy endpoint rate limit: 10 requests per minute per IP. */
export const heavyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests to this endpoint — try again later" },
  handler: (_req, res, _next, options) => {
    console.warn(`[rate-limit] Heavy limit hit: ${_req.ip} → ${_req.path}`);
    res.status(429).json(options.message);
  },
});
