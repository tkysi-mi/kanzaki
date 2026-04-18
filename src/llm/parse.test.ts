import { describe, it, expect } from "vitest";
import { parseReviewResponse } from "./parse.js";

describe("parseReviewResponse", () => {
  it("parses plain JSON (no code fence)", () => {
    const raw = JSON.stringify({
      results: [{ rule: "a", passed: true, reason: "ok" }],
      summary: "s",
    });
    const parsed = parseReviewResponse(raw);
    expect(parsed.summary).toBe("s");
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toEqual({ rule: "a", passed: true, reason: "ok" });
  });

  it("strips ```json fence", () => {
    const raw = '```json\n{"results":[{"rule":"x","passed":false,"reason":"y"}],"summary":"z"}\n```';
    const parsed = parseReviewResponse(raw);
    expect(parsed.results[0].passed).toBe(false);
    expect(parsed.summary).toBe("z");
  });

  it("strips unlabeled ``` fence", () => {
    const raw = '```\n{"results":[],"summary":""}\n```';
    const parsed = parseReviewResponse(raw);
    expect(parsed.results).toEqual([]);
  });

  it("coerces missing optional fields", () => {
    const raw = JSON.stringify({ results: [{ passed: true }], summary: "" });
    const parsed = parseReviewResponse(raw);
    expect(parsed.results[0]).toEqual({ rule: "", passed: true, reason: "" });
  });

  it("throws if results is missing", () => {
    expect(() => parseReviewResponse('{"summary":"x"}')).toThrow(/results/);
  });

  it("throws on invalid JSON, including source label", () => {
    expect(() => parseReviewResponse("not json", "Claude CLI")).toThrow(/Claude CLI/);
  });

  it("does not include severity in output", () => {
    const raw = JSON.stringify({
      results: [{ rule: "a", passed: true, reason: "ok", severity: "warn" }],
      summary: "",
    });
    const parsed = parseReviewResponse(raw);
    expect("severity" in parsed.results[0]).toBe(false);
  });
});
