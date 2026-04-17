import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scrubSecrets } from "../src/utils/sentry.js";

const sentryMocks = vi.hoisted(() => ({
  init: vi.fn(),
  flush: vi.fn().mockResolvedValue(true),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withScope: vi.fn((cb: (scope: {
    setTag: (k: string, v: string) => void;
    setExtra: (k: string, v: unknown) => void;
    setLevel: (l: string) => void;
  }) => void) => {
    cb({ setTag: vi.fn(), setExtra: vi.fn(), setLevel: vi.fn() });
  }),
}));

vi.mock("@sentry/node", () => sentryMocks);

describe("sentry scrubSecrets", () => {
  it("redacts values with sensitive-looking keys", () => {
    const input = { user: "alice", api_key: "abc123", token: "xyz", ok: 1 };
    const out = scrubSecrets(input) as Record<string, unknown>;
    expect(out["user"]).toBe("alice");
    expect(out["api_key"]).toBe("[REDACTED]");
    expect(out["token"]).toBe("[REDACTED]");
    expect(out["ok"]).toBe(1);
  });

  it("redacts nested sensitive keys", () => {
    const input = { request: { headers: { authorization: "Bearer xyz" } } };
    const out = scrubSecrets(input) as { request: { headers: Record<string, string> } };
    expect(out.request.headers["authorization"]).toBe("[REDACTED]");
  });

  it("caps recursion depth", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cycle: any = { a: 1 };
    cycle.self = cycle;
    expect(() => scrubSecrets(cycle)).not.toThrow();
  });

  it("leaves primitives alone", () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets("hello")).toBe("hello");
    expect(scrubSecrets(null)).toBe(null);
  });
});

describe("sentry wrappers (DSN unset)", () => {
  let prevDsn: string | undefined;

  beforeEach(() => {
    prevDsn = process.env["SENTRY_DSN"];
    delete process.env["SENTRY_DSN"];
    sentryMocks.init.mockClear();
    sentryMocks.captureException.mockClear();
  });

  afterEach(() => {
    if (prevDsn !== undefined) process.env["SENTRY_DSN"] = prevDsn;
  });

  it("initSentry is a no-op without DSN and isSentryEnabled returns false", async () => {
    vi.resetModules();
    const mod = await import("../src/utils/sentry.js");
    mod.initSentry();
    expect(mod.isSentryEnabled()).toBe(false);
    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it("captureException is safe with Sentry disabled", async () => {
    vi.resetModules();
    const mod = await import("../src/utils/sentry.js");
    expect(() => mod.captureException(new Error("nope"))).not.toThrow();
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });
});

describe("sentry wrappers (DSN set)", () => {
  let prevDsn: string | undefined;

  beforeEach(() => {
    prevDsn = process.env["SENTRY_DSN"];
    process.env["SENTRY_DSN"] = "https://fake@o0.ingest.sentry.io/0";
    sentryMocks.init.mockClear();
    sentryMocks.captureException.mockClear();
    sentryMocks.withScope.mockClear();
  });

  afterEach(() => {
    if (prevDsn !== undefined) process.env["SENTRY_DSN"] = prevDsn;
    else delete process.env["SENTRY_DSN"];
  });

  it("initSentry calls Sentry.init and isSentryEnabled returns true", async () => {
    vi.resetModules();
    const mod = await import("../src/utils/sentry.js");
    mod.initSentry();
    expect(mod.isSentryEnabled()).toBe(true);
    expect(sentryMocks.init).toHaveBeenCalledTimes(1);
  });

  it("captureException routes to Sentry.captureException with scope", async () => {
    vi.resetModules();
    const mod = await import("../src/utils/sentry.js");
    mod.initSentry();
    mod.captureException(new Error("boom"), { component: "faa-diff", rows: 100 });
    expect(sentryMocks.withScope).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
  });
});
