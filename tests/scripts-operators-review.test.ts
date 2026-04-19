import { describe, it, expect, vi } from "vitest";
import type pg from "pg";
import {
  parseArgs,
  parseActionKey,
  formatRowDisplay,
  approveMatch,
  rejectAndCreateNew,
  addAlias,
  escalate,
  type PendingRow,
  type CandidateRef,
} from "../scripts/operators-review.js";

const baseRow: PendingRow = {
  id: 42,
  scraped_name: "NetJets Aviation",
  scraped_source: "wyvern",
  scraped_source_id: "123",
  scraped_payload: { _resolver_reason: "medium_name_only" },
  candidate_matches: [
    { operator_id: "uuid-top", canonical_name: "NetJets Aviation Inc", score: 0.88 },
    { operator_id: "uuid-second", canonical_name: "NetJets Sales", score: 0.71 },
  ],
  reviewer_notes: "Labeler note: top candidate is right.",
  created_at: "2026-04-19T10:00:00Z",
};

// ── Arg + action parsing ─────────────────────────────────────────────────

describe("parseArgs", () => {
  it("defaults to no limit", () => {
    expect(parseArgs([])).toEqual({ limit: null, help: false });
  });
  it("reads --limit N", () => {
    expect(parseArgs(["--limit", "10"])).toEqual({ limit: 10, help: false });
  });
  it("detects --help / -h", () => {
    expect(parseArgs(["--help"])).toEqual({ limit: null, help: true });
    expect(parseArgs(["-h"])).toEqual({ limit: null, help: true });
  });
  it("ignores garbage --limit values", () => {
    expect(parseArgs(["--limit", "abc"])).toEqual({ limit: null, help: false });
  });
});

describe("parseActionKey", () => {
  const cases: Array<[string, string | null]> = [
    ["a", "approve"],
    ["A", "approve"],
    ["approve", "approve"],
    ["r", "reject"],
    ["reject", "reject"],
    ["d", "defer"],
    ["l", "add-alias"],
    ["alias", "add-alias"],
    ["e", "escalate"],
    ["n", "pick-other"],
    ["other", "pick-other"],
    ["q", "quit"],
    ["exit", "quit"],
    [" a ", "approve"],
    ["x", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    it(`maps "${input}" → ${expected ?? "null"}`, () => {
      expect(parseActionKey(input)).toBe(expected);
    });
  }
});

// ── Display formatting ───────────────────────────────────────────────────

describe("formatRowDisplay", () => {
  it("includes scraped name + source in the header", () => {
    const out = formatRowDisplay(baseRow, 1, 1);
    expect(out).toContain("NetJets Aviation");
    expect(out).toContain("wyvern");
    expect(out).toContain("row id 42");
  });

  it("surfaces reviewer_notes prominently with the clipboard emoji", () => {
    const out = formatRowDisplay(baseRow, 1, 1);
    expect(out).toContain("📝 Labeler note");
    expect(out).toContain("top candidate is right");
  });

  it("lists all candidates with score + rank", () => {
    const out = formatRowDisplay(baseRow, 1, 1);
    expect(out).toContain("[1] 0.880  NetJets Aviation Inc");
    expect(out).toContain("[2] 0.710  NetJets Sales");
  });

  it("works when reviewer_notes is null (no clipboard section)", () => {
    const out = formatRowDisplay({ ...baseRow, reviewer_notes: null }, 3, 10);
    expect(out).not.toContain("📝");
    expect(out).toContain("Review 3/10");
  });
});

// ── Action handlers with mock client ─────────────────────────────────────

function mockClient(): { client: pg.PoolClient; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.PoolClient;
  return { client, queries };
}

describe("approveMatch — writes identity + flips review status", () => {
  it("INSERTs operator_identities with match_confidence='manual' and UPDATEs the review row to 'matched'", async () => {
    const { client, queries } = mockClient();
    const candidate: CandidateRef = baseRow.candidate_matches[0]!;
    await approveMatch(client, baseRow, candidate);
    expect(queries.length).toBe(2);
    expect(queries[0]!.sql).toMatch(/INSERT INTO operator_identities/);
    expect(queries[0]!.sql).toContain("'manual'");
    expect(queries[1]!.sql).toMatch(/UPDATE operator_match_review/);
    expect(queries[1]!.sql).toContain("'matched'");
  });
});

describe("rejectAndCreateNew — INSERTs operator + identity, status='new_operator'", () => {
  it("creates a fresh operators row and links the scraped source_id to it", async () => {
    const { client, queries } = mockClient();
    await rejectAndCreateNew(client, baseRow);
    expect(queries.length).toBe(3);
    expect(queries[0]!.sql).toMatch(/INSERT INTO operators/);
    expect(queries[1]!.sql).toMatch(/INSERT INTO operator_identities/);
    expect(queries[1]!.sql).toContain("'exact'");
    expect(queries[2]!.sql).toMatch(/UPDATE operator_match_review/);
    expect(queries[2]!.sql).toContain("'new_operator'");
  });
});

describe("addAlias — approves match AND records alias", () => {
  it("runs the approve path plus an INSERT INTO operator_aliases", async () => {
    const { client, queries } = mockClient();
    const candidate: CandidateRef = baseRow.candidate_matches[0]!;
    await addAlias(client, baseRow, candidate);
    expect(queries.length).toBe(3);
    // 1: INSERT operator_identities (from approveMatch)
    expect(queries[0]!.sql).toMatch(/INSERT INTO operator_identities/);
    // 2: UPDATE operator_match_review (from approveMatch)
    expect(queries[1]!.sql).toMatch(/UPDATE operator_match_review/);
    // 3: INSERT operator_aliases
    expect(queries[2]!.sql).toMatch(/INSERT INTO operator_aliases/);
    expect(queries[2]!.sql).toContain("'dba'");
  });
});

describe("escalate — skips with [ESCALATED] prefix in notes", () => {
  it("prepends [ESCALATED] to existing reviewer_notes", async () => {
    const { client, queries } = mockClient();
    await escalate(client, baseRow);
    expect(queries.length).toBe(1);
    expect(queries[0]!.sql).toContain("'skipped'");
    expect(queries[0]!.params[0]).toMatch(/^\[ESCALATED\]/);
    expect(queries[0]!.params[0]).toContain("top candidate is right");
  });

  it("uses bare [ESCALATED] when no prior notes", async () => {
    const { client, queries } = mockClient();
    await escalate(client, { ...baseRow, reviewer_notes: null });
    expect(queries[0]!.params[0]).toBe("[ESCALATED]");
  });
});

// ── Pre-flight gate ──────────────────────────────────────────────────────

describe("pre-flight gate (via isCalibrated)", () => {
  it("commit 8b calibration must have set calibrated_at before review runs", async () => {
    const { isCalibrated, THRESHOLDS } = await import("../src/memory/canonical/match-thresholds.js");
    // After 8b: THRESHOLDS.calibrated_at should be an ISO string, not null.
    expect(THRESHOLDS.calibrated_at).not.toBeNull();
    expect(isCalibrated()).toBe(true);
  });
});
