import { describe, it, expect, vi, beforeEach } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  captureFatal: vi.fn(),
}));

vi.mock("../src/utils/sentry.js", () => ({
  captureException: sentryMocks.captureException,
  captureFatal: sentryMocks.captureFatal,
  initSentry: vi.fn(),
  flushSentry: vi.fn().mockResolvedValue(undefined),
  isSentryEnabled: vi.fn().mockReturnValue(false),
  scrubSecrets: (x: unknown) => x,
}));

function captured(): { sink: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf-8"));
      cb();
    },
  });
  return {
    sink,
    lines: () =>
      chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("logger", () => {
  beforeEach(() => {
    sentryMocks.captureException.mockClear();
    sentryMocks.captureFatal.mockClear();
  });

  it("exposes info/warn/error/fatal/debug methods on the shared logger", async () => {
    const { childLogger } = await import("../src/utils/logger.js");
    const log = childLogger("test");
    for (const m of ["info", "warn", "error", "fatal", "debug", "trace"] as const) {
      expect(typeof log[m]).toBe("function");
    }
  });

  it("child adds component + inherits service/version base fields", () => {
    const cap = captured();
    const base = pino({ base: { service: "osa-dumont", version: "x" } }, cap.sink);
    const child = base.child({ component: "faa-diff" });
    child.info({ rows: 3 }, "hello");
    const [line] = cap.lines();
    expect(line!["component"]).toBe("faa-diff");
    expect(line!["service"]).toBe("osa-dumont");
    expect(line!["rows"]).toBe(3);
    expect(line!["msg"]).toBe("hello");
  });

  it("respects level filtering via LOG_LEVEL semantics", () => {
    const cap = captured();
    const log = pino({ level: "warn" }, cap.sink);
    log.info({ x: 1 }, "filtered");
    log.warn({ x: 2 }, "kept");
    const lines = cap.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!["msg"]).toBe("kept");
  });

  it("serializes Error with stack trace when passed via err field", () => {
    const cap = captured();
    const log = pino(cap.sink);
    const err = new Error("boom");
    log.error({ err }, "operation failed");
    const [line] = cap.lines();
    const serialized = line!["err"] as { type: string; message: string; stack: string };
    expect(serialized.type).toBe("Error");
    expect(serialized.message).toBe("boom");
    expect(typeof serialized.stack).toBe("string");
  });
});

describe("logger → Sentry bridge", () => {
  beforeEach(() => {
    sentryMocks.captureException.mockClear();
    sentryMocks.captureFatal.mockClear();
  });

  it("log.error calls captureException once with component + extra", async () => {
    vi.resetModules();
    const { childLogger } = await import("../src/utils/logger.js");
    const log = childLogger("bridge-test");
    const err = new Error("oops");
    log.error({ err, tail: "N788QS" }, "failed");
    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
    const [errArg, extraArg] = sentryMocks.captureException.mock.calls[0]!;
    expect(errArg).toBe(err);
    expect(extraArg).toMatchObject({ component: "bridge-test", tail: "N788QS", msg: "failed" });
    expect(sentryMocks.captureFatal).not.toHaveBeenCalled();
  });

  it("log.fatal calls captureFatal once", async () => {
    vi.resetModules();
    const { childLogger } = await import("../src/utils/logger.js");
    const log = childLogger("bridge-test");
    log.fatal({ err: new Error("bad") }, "very bad");
    expect(sentryMocks.captureFatal).toHaveBeenCalledTimes(1);
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
  });

  it("log.warn does NOT call Sentry", async () => {
    vi.resetModules();
    const { childLogger } = await import("../src/utils/logger.js");
    const log = childLogger("bridge-test");
    log.warn({ reason: "retry" }, "warning");
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.captureFatal).not.toHaveBeenCalled();
  });

  it("log.info does NOT call Sentry", async () => {
    vi.resetModules();
    const { childLogger } = await import("../src/utils/logger.js");
    const log = childLogger("bridge-test");
    log.info({ rows: 42 }, "ok");
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.captureFatal).not.toHaveBeenCalled();
  });
});
