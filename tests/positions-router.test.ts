import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  queryPositions,
  handlers,
  HOT_BOUNDARY_SECONDS,
  DEFAULT_LIMIT,
  type PositionQuery,
  type PositionResult,
} from "../src/query/positions-router.js";

// Fake row factory for predictable shape checks
function fakeRow(icao: string, ts: number, tier: "hot" | "cold"): PositionResult {
  return {
    icao_hex: icao,
    tail_number: tier === "hot" ? "N123" : "N999",
    callsign: null,
    latitude: 40.0,
    longitude: -100.0,
    altitude_ft: 35_000,
    ground_speed_kts: 450,
    heading: 90,
    vertical_rate: null,
    on_ground: false,
    nearest_airport: null,
    timestamp: ts,
  };
}

describe("queryPositions router", () => {
  let hotSpy: ReturnType<typeof vi.fn>;
  let coldSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hotSpy = vi.fn();
    coldSpy = vi.fn();
    handlers.queryHot = hotSpy as unknown as typeof handlers.queryHot;
    handlers.queryCold = coldSpy as unknown as typeof handlers.queryCold;
  });

  it("routes entirely-hot query (within 48h) to queryHot only", async () => {
    const now = Math.floor(Date.now() / 1000);
    hotSpy.mockResolvedValue([fakeRow("a12345", now - 100, "hot")]);
    coldSpy.mockResolvedValue([]);

    const q: PositionQuery = { timeStart: now - 3600, timeEnd: now };
    const result = await queryPositions(q);

    expect(hotSpy).toHaveBeenCalledTimes(1);
    expect(coldSpy).toHaveBeenCalledTimes(0);
    expect(result).toHaveLength(1);
    expect(result[0]!.tail_number).toBe("N123"); // hot tier marker
  });

  it("routes entirely-cold query (older than 48h) to queryCold only", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldStart = now - 10 * 86400;
    const oldEnd = now - 9 * 86400;
    hotSpy.mockResolvedValue([]);
    coldSpy.mockResolvedValue([fakeRow("a54321", oldStart + 100, "cold")]);

    const result = await queryPositions({ timeStart: oldStart, timeEnd: oldEnd });

    expect(hotSpy).toHaveBeenCalledTimes(0);
    expect(coldSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]!.tail_number).toBe("N999");
  });

  it("routes spanning query to both tiers, merges, dedupes, and sorts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hotCutoff = now - HOT_BOUNDARY_SECONDS;
    // range covers 72h ago through now — crosses the 48h boundary
    const q: PositionQuery = { timeStart: now - 72 * 3600, timeEnd: now };

    hotSpy.mockResolvedValue([
      fakeRow("a00001", hotCutoff + 200, "hot"),
      fakeRow("a00001", hotCutoff + 500, "hot"),
    ]);
    coldSpy.mockResolvedValue([
      fakeRow("a00001", hotCutoff - 500, "cold"),
      fakeRow("a00001", hotCutoff - 100, "cold"),
    ]);

    const result = await queryPositions(q);

    expect(hotSpy).toHaveBeenCalledTimes(1);
    expect(coldSpy).toHaveBeenCalledTimes(1);
    expect(hotSpy.mock.calls[0]![0]!.timeStart).toBe(hotCutoff);
    expect(coldSpy.mock.calls[0]![0]!.timeEnd).toBe(hotCutoff);
    expect(result).toHaveLength(4);
    // Sorted by timestamp ascending
    expect(result.map((r) => r.timestamp)).toEqual(
      [hotCutoff - 500, hotCutoff - 100, hotCutoff + 200, hotCutoff + 500],
    );
  });

  it("dedupes rows with same (icao, timestamp) across tiers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hotCutoff = now - HOT_BOUNDARY_SECONDS;
    const q: PositionQuery = { timeStart: now - 72 * 3600, timeEnd: now };

    // Both tiers return a row at exactly hotCutoff — should appear once.
    hotSpy.mockResolvedValue([fakeRow("a00001", hotCutoff, "hot")]);
    coldSpy.mockResolvedValue([fakeRow("a00001", hotCutoff, "cold")]);

    const result = await queryPositions(q);
    expect(result).toHaveLength(1);
  });

  it("returns empty array for cold-only range with no packaged parquet days", async () => {
    const now = Math.floor(Date.now() / 1000);
    hotSpy.mockResolvedValue([]);
    coldSpy.mockResolvedValue([]); // no available parquet → empty

    const result = await queryPositions({
      timeStart: now - 30 * 86400,
      timeEnd: now - 29 * 86400,
    });

    expect(coldSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it("passes bbox filter through to the right tier", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bbox = { minLat: 30, maxLat: 50, minLon: -130, maxLon: -60 };
    hotSpy.mockResolvedValue([]);

    await queryPositions({ timeStart: now - 3600, timeEnd: now, bbox });

    expect(hotSpy.mock.calls[0]![0]!.bbox).toEqual(bbox);
  });

  it("passes limit through to the invoked tier", async () => {
    const now = Math.floor(Date.now() / 1000);
    hotSpy.mockResolvedValue([]);

    await queryPositions({ timeStart: now - 3600, timeEnd: now, limit: 500 });

    expect(hotSpy.mock.calls[0]![0]!.limit).toBe(500);
  });

  it("returns empty result on zero-width or inverted time range", async () => {
    const now = Math.floor(Date.now() / 1000);
    const r1 = await queryPositions({ timeStart: now, timeEnd: now });
    const r2 = await queryPositions({ timeStart: now, timeEnd: now - 100 });
    expect(r1).toEqual([]);
    expect(r2).toEqual([]);
    expect(hotSpy).toHaveBeenCalledTimes(0);
    expect(coldSpy).toHaveBeenCalledTimes(0);
  });

  it("hot and cold result shapes are identical (same field set)", async () => {
    const hotRow = fakeRow("a00001", 1000, "hot");
    const coldRow = fakeRow("a00002", 500, "cold");
    expect(Object.keys(hotRow).sort()).toEqual(Object.keys(coldRow).sort());
    // And confirm the defaulted limit constant is the expected value
    expect(DEFAULT_LIMIT).toBe(100_000);
  });
});
