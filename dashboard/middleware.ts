import { next } from "@vercel/edge";
import type { RequestContext } from "@vercel/edge";

const PUBLIC_PATHS = ["/login.html", "/api/auth"];

export const config = {
  matcher: ["/((?!_next/static|_next/image|icons/|manifest.json|sw.js|favicon).*)"],
};

export default async function middleware(request: Request, _ctx: RequestContext) {
  const url = new URL(request.url);

  if (PUBLIC_PATHS.some((p) => url.pathname.startsWith(p))) {
    return next();
  }

  const cookie = parseCookie(request.headers.get("cookie") ?? "");
  const token = cookie["mc_session"];

  if (!token) {
    return Response.redirect(new URL("/login.html", request.url), 302);
  }

  const secret = process.env.MC_SESSION_SECRET;
  if (!secret) {
    return Response.redirect(new URL("/login.html", request.url), 302);
  }

  const valid = await verifyToken(token, secret);
  if (!valid) {
    return Response.redirect(new URL("/login.html", request.url), 302);
  }

  return next();
}

function parseCookie(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;

  try {
    const data = JSON.parse(atob(payload));
    if (!data.exp || Date.now() > data.exp) return false;

    const expected = await hmacSign(payload, secret);
    return timingSafeEqual(signature, expected);
  } catch {
    return false;
  }
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
