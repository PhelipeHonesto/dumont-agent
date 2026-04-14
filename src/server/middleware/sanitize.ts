/**
 * Input sanitization and validation for API endpoints.
 *
 * Validators return the cleaned value or throw a SanitizeError (caught by route handlers).
 * Use inline in route handlers — no middleware wrappers needed.
 */

// ── Error class ─────────────────────────────────────────────────────────────

export class SanitizeError extends Error {
  public status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "SanitizeError";
    this.status = status;
  }
}

// ── Tail number ─────────────────────────────────────────────────────────────

const TAIL_RE = /^N[A-Z0-9]{1,5}$/;

/** Validate US tail number: N + 1-5 alphanumeric. Returns uppercased. */
export function validateTailNumber(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!TAIL_RE.test(s)) {
    throw new SanitizeError("Invalid tail number — expected N followed by 1-5 alphanumeric characters");
  }
  return s;
}

// ── ICAO airport code ───────────────────────────────────────────────────────

const ICAO_RE = /^[A-Z]{4}$/;

/** Validate ICAO airport code: exactly 4 uppercase letters. */
export function validateIcaoCode(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  if (!ICAO_RE.test(s)) {
    throw new SanitizeError("Invalid ICAO code — expected exactly 4 letters (e.g. KTEB)");
  }
  return s;
}

// ── Generic string sanitizer ────────────────────────────────────────────────

const SQL_PATTERNS = /(['";]|--|\*\/|\/\*|\bDROP\b|\bDELETE\b|\bUPDATE\b|\bINSERT\b|\bALTER\b|\bEXEC\b)/i;

/** Sanitize a free-text string: max 100 chars, no SQL injection patterns. */
export function sanitizeString(raw: unknown, maxLen = 100): string {
  const s = String(raw ?? "").trim().slice(0, maxLen);
  if (SQL_PATTERNS.test(s)) {
    throw new SanitizeError("Invalid input — contains disallowed characters");
  }
  return s;
}

// ── Numeric param ───────────────────────────────────────────────────────────

/** Validate and clamp a positive integer. Returns defaultVal if missing/invalid. */
export function validatePositiveInt(
  raw: unknown,
  defaultVal: number,
  max: number,
): number {
  if (raw == null || raw === "") return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(Math.floor(n), max);
}

// ── Month ───────────────────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Validate YYYY-MM format. Rejects months more than 1 month in the future. */
export function validateMonth(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  const s = String(raw).trim();
  if (!MONTH_RE.test(s)) {
    throw new SanitizeError("Invalid month — expected YYYY-MM format");
  }
  // Reject future months beyond current + 1
  const now = new Date();
  const maxMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 1st of month after next
  const [year, month] = s.split("-").map(Number) as [number, number];
  const input = new Date(year, month - 1, 1);
  if (input > maxMonth) {
    throw new SanitizeError("Invalid month — too far in the future");
  }
  return s;
}

// ── Date ────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Validate YYYY-MM-DD format. */
export function validateDate(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  const s = String(raw).trim();
  if (!DATE_RE.test(s)) {
    throw new SanitizeError("Invalid date — expected YYYY-MM-DD format");
  }
  return s;
}

// ── Aircraft class ──────────────────────────────────────────────────────────

const VALID_CLASSES = new Set(["light", "midsize", "super_mid", "heavy", "turboprop"]);

/** Validate aircraft class. Returns undefined if not provided. */
export function validateAircraftClass(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  const s = String(raw).trim().toLowerCase();
  if (!VALID_CLASSES.has(s)) {
    throw new SanitizeError(`Invalid aircraft class — expected one of: ${[...VALID_CLASSES].join(", ")}`);
  }
  return s;
}

// ── Offset ──────────────────────────────────────────────────────────────────

/** Validate and clamp a non-negative offset. Returns 0 if missing/invalid. */
export function clampOffset(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// ── Express error helper ────────────────────────────────────────────────────

import type { Response } from "express";

/** Catch SanitizeError and send 400 response. Returns true if handled. */
export function handleSanitizeError(err: unknown, res: Response): boolean {
  if (err instanceof SanitizeError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}
