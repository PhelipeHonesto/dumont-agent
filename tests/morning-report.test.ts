import { describe, it, expect } from "vitest";
import { parseArgs, formatReport, type PipelineRow, type DqRow, type ReportData } from "../scripts/morning-report.js";

describe("parseArgs", () => {
  it("defaults to 24-hour window and stdout-only", () => {
    expect(parseArgs([])).toEqual({ windowHours: 24, out: null });
  });
  it("parses --window-hours N", () => {
    expect(parseArgs(["--window-hours", "72"])).toEqual({ windowHours: 72, out: null });
  });
  it("parses --out path", () => {
    expect(parseArgs(["--out", "/tmp/report.md"])).toEqual({ windowHours: 24, out: "/tmp/report.md" });
  });
  it("ignores garbage --window-hours values", () => {
    expect(parseArgs(["--window-hours", "abc"])).toEqual({ windowHours: 24, out: null });
  });
});

describe("formatReport", () => {
  const emptyData: ReportData = {
    windowHours: 24,
    generatedAt: "2026-04-19T07:00:00Z",
    pipelineRuns: [],
    dqRuns: [],
  };

  it("includes window and generated timestamp in the header", () => {
    const md = formatReport(emptyData);
    expect(md).toContain("# Dumont morning report");
    expect(md).toContain("2026-04-19T07:00:00Z");
    expect(md).toContain("last 24 h");
  });

  it("reports empty state for both sections when no runs", () => {
    const md = formatReport(emptyData);
    expect(md).toContain("_No pipeline runs recorded in the window._");
    expect(md).toContain("_No DQ runs recorded in the window._");
  });

  it("groups pipeline runs by job_name in a markdown table", () => {
    const runs: PipelineRow[] = [
      { id: 1, job_name: "archive_adsb", started_at: "2026-04-19T01:00:00Z", ended_at: "2026-04-19T01:05:00Z", status: "completed", row_count_delta: 500, error_message: null, metadata: {} },
      { id: 2, job_name: "archive_adsb", started_at: "2026-04-19T02:00:00Z", ended_at: "2026-04-19T02:03:00Z", status: "completed", row_count_delta: 100, error_message: null, metadata: {} },
      { id: 3, job_name: "dq_check", started_at: "2026-04-19T03:00:00Z", ended_at: "2026-04-19T03:00:02Z", status: "failed", row_count_delta: 0, error_message: "timeout", metadata: {} },
    ];
    const md = formatReport({ ...emptyData, pipelineRuns: runs });
    expect(md).toContain("| `archive_adsb` | 2 | 0 | 0 | 600 |");
    expect(md).toContain("| `dq_check` | 0 | 1 | 0 | 0 |");
  });

  it("surfaces failure details in a dedicated section with error_message", () => {
    const runs: PipelineRow[] = [
      { id: 5, job_name: "archive_adsb", started_at: "2026-04-19T01:00:00Z", ended_at: null, status: "failed", row_count_delta: 0, error_message: "S3 timeout", metadata: {} },
    ];
    const md = formatReport({ ...emptyData, pipelineRuns: runs });
    expect(md).toContain("### Pipeline failures");
    expect(md).toContain("**archive_adsb**");
    expect(md).toContain("S3 timeout");
  });

  it("summarises DQ pass/fail counts and shows failures inline", () => {
    const dq: DqRow[] = [
      { run_at: "2026-04-19T03:00:00Z", run_id: "run-a", check_name: "faa_registry_count", status: "pass", actual_value: "314811", threshold: ">= 100000" },
      { run_at: "2026-04-19T03:00:01Z", run_id: "run-a", check_name: "adsb_leg_duplicates", status: "fail", actual_value: "12", threshold: "= 0 (last 7d)" },
    ];
    const md = formatReport({ ...emptyData, dqRuns: dq });
    expect(md).toMatch(/1\/2 passed.*1 failed/);
    expect(md).toContain("### DQ failures");
    expect(md).toContain("**adsb_leg_duplicates**");
    expect(md).toContain("actual=`12`");
  });

  it("does not show DQ failure section when all checks passed", () => {
    const dq: DqRow[] = [
      { run_at: "2026-04-19T03:00:00Z", run_id: "run-a", check_name: "faa_registry_count", status: "pass", actual_value: "314811", threshold: ">= 100000" },
    ];
    const md = formatReport({ ...emptyData, dqRuns: dq });
    expect(md).not.toContain("### DQ failures");
    expect(md).toMatch(/1\/1 passed/);
  });
});
