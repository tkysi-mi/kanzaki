import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewResult } from "../llm/types.js";
import { report } from "./reporter.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let lines: string[];

beforeEach(() => {
  lines = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

const joined = () => lines.join("\n");

describe("report", () => {
  it("prints 'All N rules passed' when everything passed", () => {
    const result: ReviewResult = {
      results: [
        { rule: "a", passed: true, reason: "ok", severity: "error" },
        { rule: "b", passed: true, reason: "ok", severity: "warn" },
      ],
      summary: "clean",
    };
    const s = report(result, false);
    expect(s).toEqual({ errorCount: 0, warnCount: 0 });
    expect(joined()).toContain("All 2 rules passed");
    expect(joined()).toContain("clean");
  });

  it("counts errors and warnings separately and blocks on errors", () => {
    const result: ReviewResult = {
      results: [
        { rule: "a", passed: true, reason: "ok", severity: "error" },
        {
          rule: "b",
          passed: false,
          reason: "bad error",
          severity: "error",
        },
        {
          rule: "c",
          passed: false,
          reason: "soft warn",
          severity: "warn",
        },
      ],
      summary: "issues found",
    };
    const s = report(result, false);
    expect(s).toEqual({ errorCount: 1, warnCount: 1 });
    const out = joined();
    expect(out).toContain("1/3 passed");
    expect(out).toContain("1 errors");
    expect(out).toContain("1 warnings");
    expect(out).toContain("Review failed");
    expect(out).toContain("bad error");
    expect(out).toContain("soft warn");
  });

  it("downgrades block message when --no-block is set", () => {
    const result: ReviewResult = {
      results: [
        { rule: "a", passed: false, reason: "boom", severity: "error" },
      ],
      summary: "",
    };
    report(result, false, true);
    const out = joined();
    expect(out).toContain("not blocked (--no-block)");
    expect(out).not.toContain("Review failed");
  });

  it("uses a warning-only message when only warnings fail", () => {
    const result: ReviewResult = {
      results: [
        { rule: "a", passed: false, reason: "softfail", severity: "warn" },
      ],
      summary: "",
    };
    report(result, false);
    expect(joined()).toContain("Warnings only — not blocking");
  });

  it("prints pass reasons only in verbose mode", () => {
    const result: ReviewResult = {
      results: [
        {
          rule: "a",
          passed: true,
          reason: "detailed-pass-note",
          severity: "error",
        },
      ],
      summary: "",
    };
    report(result, false);
    expect(joined()).not.toContain("detailed-pass-note");
    lines = [];
    report(result, true);
    expect(joined()).toContain("detailed-pass-note");
  });

  it("does not print an empty summary line", () => {
    const result: ReviewResult = {
      results: [{ rule: "a", passed: true, reason: "ok", severity: "error" }],
      summary: "",
    };
    report(result, false);
    // the dim summary line follows '  ' + summary; checking substring safe enough
    expect(joined()).not.toMatch(/All 1 rules passed[\s\S]+ {2}\n/);
  });
});
