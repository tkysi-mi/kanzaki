import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewResult } from "../llm/types.js";
import { writeFeedbackFile } from "./feedback.js";
import type { ReviewSource } from "./git.js";
import { parseRulesFromContent } from "./parser.js";

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "kanzaki-feedback-test-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const rules = parseRulesFromContent(
  "## Quality (*.ts)\n- [ ] !warn 短く書く\n- [ ] テスト追加必須\n",
).rules;

const stagedSource: ReviewSource = {
  kind: "staged",
  label: "staged",
  diff: "",
  files: ["src/a.ts", "src/b.ts"],
};

describe("writeFeedbackFile", () => {
  it("returns null and writes nothing when all rules pass", () => {
    const result: ReviewResult = {
      results: [
        { rule: "短く書く", passed: true, reason: "ok", severity: "warn" },
        {
          rule: "テスト追加必須",
          passed: true,
          reason: "ok",
          severity: "error",
        },
      ],
      summary: "all good",
    };
    const path = writeFeedbackFile(result, rules, stagedSource, outDir);
    expect(path).toBeNull();
  });

  it("writes a timestamped .md when there are failures", () => {
    const result: ReviewResult = {
      results: [
        {
          rule: "テスト追加必須",
          passed: false,
          reason: "No tests added",
          severity: "error",
        },
      ],
      summary: "needs work",
    };
    const path = writeFeedbackFile(result, rules, stagedSource, outDir);
    expect(path).not.toBeNull();
    expect(existsSync(path!)).toBe(true);
    expect(path!).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
  });

  it("creates the outputDir if it doesn't exist", () => {
    const nested = join(outDir, "does", "not", "exist");
    const result: ReviewResult = {
      results: [
        { rule: "短く書く", passed: false, reason: "長い", severity: "warn" },
      ],
      summary: "",
    };
    const path = writeFeedbackFile(result, rules, stagedSource, nested);
    expect(path).not.toBeNull();
    expect(existsSync(nested)).toBe(true);
  });

  it("reports error/warn counts and attaches rule metadata", () => {
    const result: ReviewResult = {
      results: [
        {
          rule: "短く書く",
          passed: false,
          reason: "too wordy",
          severity: "warn",
        },
        {
          rule: "テスト追加必須",
          passed: false,
          reason: "missing",
          severity: "error",
        },
      ],
      summary: "two issues",
    };
    const path = writeFeedbackFile(result, rules, stagedSource, outDir)!;
    const md = readFileSync(path, "utf-8");

    expect(md).toContain("# Kanzaki Review Feedback");
    expect(md).toContain("two issues");
    expect(md).toContain("- エラー: 1 件");
    expect(md).toContain("- 警告: 1 件");
    expect(md).toContain("- 対象ファイル: src/a.ts, src/b.ts");

    expect(md).toContain("[WARN] 短く書く");
    expect(md).toContain("[ERROR] テスト追加必須");
    expect(md).toContain("**グループ**: Quality");
    expect(md).toContain("**適用スコープ**: *.ts");
    expect(md).toContain("**判定スコープ**: diff（差分）");
    expect(md).toMatch(/> too wordy/);
    expect(md).toMatch(/> missing/);
  });

  it("uses '(no reason provided)' when reason is blank", () => {
    const result: ReviewResult = {
      results: [
        { rule: "短く書く", passed: false, reason: "   ", severity: "warn" },
      ],
      summary: "",
    };
    const path = writeFeedbackFile(result, rules, stagedSource, outDir)!;
    const md = readFileSync(path, "utf-8");
    expect(md).toContain("> (no reason provided)");
  });

  it("uses staged-specific re-run instructions for staged source", () => {
    const result: ReviewResult = {
      results: [
        { rule: "短く書く", passed: false, reason: "x", severity: "warn" },
      ],
      summary: "",
    };
    const path = writeFeedbackFile(result, rules, stagedSource, outDir)!;
    const md = readFileSync(path, "utf-8");
    expect(md).toContain("git add");
  });

  it("uses generic instructions for non-staged sources", () => {
    const filesSource: ReviewSource = {
      kind: "files",
      label: "files",
      diff: "",
      files: ["a.md"],
    };
    const result: ReviewResult = {
      results: [
        { rule: "短く書く", passed: false, reason: "x", severity: "warn" },
      ],
      summary: "",
    };
    const path = writeFeedbackFile(result, rules, filesSource, outDir)!;
    const md = readFileSync(path, "utf-8");
    expect(md).not.toContain("git add");
    expect(md).toContain("同じ起点で");
  });
});
