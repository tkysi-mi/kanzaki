import { describe, expect, it } from "vitest";
import type { RawReviewResult } from "../llm/types.js";
import type { ReviewSource } from "./git.js";
import { parseRulesFromContent } from "./parser.js";
import {
  buildUserPrompt,
  mapSeverities,
  SYSTEM_PROMPT,
  truncate,
} from "./reviewer.js";

const rulesOf = (content: string) => parseRulesFromContent(content).rules;

const stagedSource = (overrides: Partial<ReviewSource> = {}): ReviewSource => ({
  kind: "staged",
  label: "staged",
  diff: "",
  files: [],
  ...overrides,
});

describe("SYSTEM_PROMPT", () => {
  it("documents the JSON response shape and scope semantics", () => {
    expect(SYSTEM_PROMPT).toMatch(/scope=diff/);
    expect(SYSTEM_PROMPT).toMatch(/scope=state/);
    expect(SYSTEM_PROMPT).toMatch(/"results":/);
    expect(SYSTEM_PROMPT).toMatch(/also_consult/);
  });
});

describe("buildUserPrompt", () => {
  const rules = rulesOf("## G\n- [ ] a rule\n");

  it("skips Project Context when rulesContext is empty/whitespace", () => {
    const p = buildUserPrompt(rules, stagedSource(), [], "   ");
    expect(p).not.toContain("Project Context");
  });

  it("includes Project Context when rulesContext provided", () => {
    const p = buildUserPrompt(rules, stagedSource(), [], "background info");
    expect(p).toContain("## Project Context");
    expect(p).toContain("background info");
  });

  it("always includes Review Source with label", () => {
    const p = buildUserPrompt(rules, stagedSource({ label: "my-label" }), []);
    expect(p).toContain("## Review Source");
    expect(p).toContain("Source: my-label");
  });

  it("adds files-only note when source kind is 'files'", () => {
    const p = buildUserPrompt(
      rules,
      stagedSource({ kind: "files", label: "files" }),
      [],
    );
    expect(p).toContain("files-only (no diff)");
  });

  it("does NOT add files-only note for staged source", () => {
    const p = buildUserPrompt(rules, stagedSource(), []);
    expect(p).not.toContain("files-only");
  });

  it("emits rendered checklist via formatRulesForPrompt", () => {
    const p = buildUserPrompt(rules, stagedSource(), []);
    expect(p).toContain("## Checklist Rules");
    expect(p).toContain("a rule");
    expect(p).toMatch(/Rule #\d+/);
  });

  it("includes diff block when diff non-empty", () => {
    const p = buildUserPrompt(
      rules,
      stagedSource({ diff: "diff --git a b\n+hello\n" }),
      [],
    );
    expect(p).toContain("## Changes (git diff)");
    expect(p).toContain("```diff");
    expect(p).toContain("+hello");
  });

  it("omits diff block when diff is empty/whitespace", () => {
    const p = buildUserPrompt(rules, stagedSource({ diff: "   " }), []);
    expect(p).not.toContain("## Changes (git diff)");
  });

  it("truncates very large diffs to ~50k", () => {
    const huge = "x".repeat(60_000);
    const p = buildUserPrompt(rules, stagedSource({ diff: huge }), []);
    expect(p).toContain("... (truncated)");
  });

  it("emits file context fences using the file extension", () => {
    const p = buildUserPrompt(rules, stagedSource(), [
      { path: "src/a.ts", content: "const x = 1;\n" },
    ]);
    expect(p).toContain("## Full File Context");
    expect(p).toContain("### src/a.ts");
    expect(p).toContain("```ts");
    expect(p).toContain("const x = 1;");
  });

  it("still renders fenced block for extension-less file paths", () => {
    const p = buildUserPrompt(rules, stagedSource(), [
      { path: "Makefile", content: "all:\n" },
    ]);
    expect(p).toContain("### Makefile");
    expect(p).toContain("all:");
  });

  it("omits Full File Context when no file contexts given", () => {
    const p = buildUserPrompt(rules, stagedSource(), []);
    expect(p).not.toContain("## Full File Context");
  });
});

describe("mapSeverities", () => {
  it("maps severities by case-insensitive rule-text match", () => {
    const rules = rulesOf(
      "- [ ] !warn Keep summary short\n- [ ] Must test all changes\n",
    );
    const raw: RawReviewResult = {
      results: [
        { rule: "keep summary short", passed: true, reason: "ok" },
        { rule: "Must test all changes", passed: false, reason: "missing" },
      ],
      summary: "ok",
    };
    const out = mapSeverities(raw, rules);
    expect(out.results[0].severity).toBe("warn");
    expect(out.results[1].severity).toBe("error");
  });

  it("defaults to 'error' when LLM returns an unknown rule text", () => {
    const rules = rulesOf("- [ ] !warn Known rule\n");
    const raw: RawReviewResult = {
      results: [
        { rule: "Phantom rule", passed: false, reason: "hallucinated" },
      ],
      summary: "",
    };
    const out = mapSeverities(raw, rules);
    expect(out.results[0].severity).toBe("error");
  });

  it("preserves summary passthrough", () => {
    const out = mapSeverities(
      { results: [], summary: "all green" },
      rulesOf("- [ ] x\n"),
    );
    expect(out.summary).toBe("all green");
  });
});

describe("truncate", () => {
  it("returns input unchanged when at or below max length", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hi", 10)).toBe("hi");
  });

  it("slices and appends the truncated marker when too long", () => {
    const out = truncate("abcdef", 3);
    expect(out.startsWith("abc")).toBe(true);
    expect(out).toContain("... (truncated)");
  });
});
