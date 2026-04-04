import type { VercelRequest, VercelResponse } from "@vercel/node";

const COOKIE_NAME = "mc_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const MAX_ATTEMPTS = 5;
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

interface RateEntry {
  attempts: number;
  blockedUntil: number;
}

const rateLimitMap = new Map<string, RateEntry>();

let lastCleanup = Date.now();
function cleanupExpired() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.blockedUntil < now && entry.attempts === 0) {
      rateLimitMap.delete(ip);
    }
  }
}

function getClientIp(req: VercelRequest): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "POST") {
    return handleLogin(req, res);
  }

  if (req.method === "DELETE") {
    return handleLogout(res);
  }

  res.setHeader("Allow", "POST, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

async function handleLogin(req: VercelRequest, res: VercelResponse) {
  cleanupExpired();

  const ip = getClientIp(req);
  const entry = rateLimitMap.get(ip);
  const now = Date.now();

  if (entry && entry.blockedUntil > now) {
    const minutesLeft = Math.ceil((entry.blockedUntil - now) / 60_000);
    return res.status(429).json({
      error: `Too many attempts. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}`,
    });
  }

  const { username, password } = req.body ?? {};

  const expectedUser = process.env.MC_USERNAME;
  const expectedPass = process.env.MC_PASSWORD;
  const sessionSecret = process.env.MC_SESSION_SECRET;

  if (!expectedUser || !expectedPass || !sessionSecret) {
    return res.status(500).json({ error: "Auth not configured" });
  }

  if (
    !username ||
    !password ||
    !timingSafeEqual(username, expectedUser) ||
    !timingSafeEqual(password, expectedPass)
  ) {
    const current = rateLimitMap.get(ip) || { attempts: 0, blockedUntil: 0 };
    current.attempts += 1;
    if (current.attempts >= MAX_ATTEMPTS) {
      current.blockedUntil = now + BLOCK_DURATION_MS;
      current.attempts = 0;
    }
    rateLimitMap.set(ip, current);
    return res.status(401).json({ error: "Invalid credentials" });
  }

  rateLimitMap.delete(ip);

  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = btoa(JSON.stringify({ sub: username, exp: expiry }));
  const signature = await hmacSign(payload, sessionSecret);
  const token = `${payload}.${signature}`;

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );

  return res.status(200).json({ ok: true });
}

function handleLogout(res: VercelResponse) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  );
  return res.status(200).json({ ok: true });
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
