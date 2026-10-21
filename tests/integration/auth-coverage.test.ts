/**
 * Auth coverage: every HTTP route must reject unauthenticated requests in
 * production, except the explicit public health probes.
 *
 * Routes are discovered from the routers themselves, so a route added later
 * is covered automatically. The server is booted as a real process (the same
 * entry point PM2 runs) because protection depends on router mount order in
 * src/server/index.ts, and that is exactly what this test guards.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PUBLIC_ROUTES = new Set(["GET /health", "GET /ready"]);
const HEAVY_PREFIXES = ["/api/analytics", "/api/routes", "/api/market"]; // 10 req/min limiter
const HEAVY_BATCH = 9;
const API_KEY = "test-dumont-key";

type Route = { method: string; path: string };

async function discoverRoutes(): Promise<Route[]> {
  const modules = await Promise.all([
    import("../../src/server/routes/conversation.js"),
    import("../../src/server/routes/health.js"),
    import("../../src/server/routes/vapi-llm.js"),
    import("../../src/server/routes/deals.js"),
    import("../../src/server/routes/chat.js"),
    import("../../src/server/routes/radar.js"),
    import("../../src/server/routes/intelligence.js"),
    import("../../src/server/routes/analytics.js"),
    import("../../src/server/routes/dashboard.js"),
    import("../../src/server/middleware/error-tracker.js"),
  ]);
  const routes: Route[] = [];
  for (const mod of modules) {
    for (const exported of Object.values(mod) as Array<{ stack?: unknown[] }>) {
      if (!Array.isArray(exported?.stack)) continue;
      for (const layer of exported.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({ method: method.toUpperCase(), path: layer.route.path });
        }
      }
    }
  }
  return routes;
}

const servers: ChildProcess[] = [];
let nextPort = 39_100 + Math.floor(Math.random() * 500);

function startServer(): Promise<number> {
  const port = nextPort++;
  const dir = mkdtempSync(join(tmpdir(), "dumont-auth-"));
  const child = spawn("npx", ["tsx", "src/server/index.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      DUMONT_API_KEY: API_KEY,
      VAPI_SECRET: "test-vapi-secret",
      DATABASE_TYPE: "sqlite",
      DATABASE_PATH: join(dir, "dumont.db"),
      SENTRY_DSN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start within 30s")), 30_000);
    child.stdout?.on("data", (buf: Buffer) => {
      if (buf.toString().includes("Server running")) {
        clearTimeout(timer);
        resolve(port);
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
  });
}

async function statusOf(port: number, route: Route, token?: string): Promise<number> {
  const url = `http://127.0.0.1:${port}${route.path.replace(/:\w+/g, "x")}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: route.method,
    headers,
    body: route.method === "GET" ? undefined : "{}",
  });
  return res.status;
}

afterAll(() => {
  for (const s of servers) s.kill("SIGKILL");
});

describe("API auth coverage (production mode)", () => {
  it("rejects unauthenticated and wrong-token requests on every non-public route", async () => {
    const routes = await discoverRoutes();
    expect(routes.length).toBeGreaterThan(30);

    const isHeavy = (r: Route) => HEAVY_PREFIXES.some((p) => r.path.startsWith(p));
    const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(`${r.method} ${r.path}`));
    const normal = protectedRoutes.filter((r) => !isHeavy(r));
    const heavy = protectedRoutes.filter(isHeavy);

    // Heavy routes share a 10 req/min limiter that runs before auth, so spread
    // them across fresh servers to get a real 401 rather than a 429.
    const batches: Route[][] = [normal];
    for (let i = 0; i < heavy.length; i += HEAVY_BATCH) batches.push(heavy.slice(i, i + HEAVY_BATCH));

    const leaks: string[] = [];
    for (const batch of batches) {
      const port = await startServer();
      for (const route of batch) {
        const noToken = await statusOf(port, route);
        if (noToken !== 401) leaks.push(`${route.method} ${route.path} (no token) -> ${noToken}`);
      }
    }
    // Wrong token, on a fresh server so limiter counts don't interfere.
    const port = await startServer();
    for (const route of normal) {
      const wrong = await statusOf(port, route, "not-the-key");
      if (wrong !== 401) leaks.push(`${route.method} ${route.path} (wrong token) -> ${wrong}`);
    }

    expect(leaks).toEqual([]);
  }, 180_000);

  it("keeps the health probes public", async () => {
    const port = await startServer();
    expect(await statusOf(port, { method: "GET", path: "/health" })).toBe(200);
    expect(await statusOf(port, { method: "GET", path: "/ready" })).toBe(200);
  }, 60_000);
});
