import { describe, it, expect } from "vitest";
import {
  parseRulesFromContent,
  filterRulesByFiles,
  formatRulesForPrompt,
  matchGlob,
} from "./parser.js";

describe("parseRulesFromContent", () => {
  it("parses a simple rule with default severity=error and scope=diff", () => {
    const { rules, errors } = parseRulesFromContent("## Quality\n- [ ] 一貫性を保つ\n");
    expect(errors).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      group: "Quality",
      text: "一貫性を保つ",
      severity: "error",
      scope: "diff",
      filePatterns: [],
      stateExtraPatterns: [],
    });
  });

  it("parses !warn severity tag", () => {
    const { rules } = parseRulesFromContent("- [ ] !warn 短く書く\n");
    expect(rules[0].severity).toBe("warn");
    expect(rules[0].text).toBe("短く書く");
  });

  it("parses @state scope tag", () => {
    const { rules } = parseRulesFromContent("- [ ] @state 機密情報なし\n");
    expect(rules[0].scope).toBe("state");
    expect(rules[0].text).toBe("機密情報なし");
  });

  it("parses @state(glob) with extra patterns", () => {
    const { rules } = parseRulesFromContent(
      "- [ ] @state(docs/*.md, README.md) 用語整合性\n",
    );
    expect(rules[0].scope).toBe("state");
    expect(rules[0].stateExtraPatterns).toEqual(["docs/*.md", "README.md"]);
  });

  it("parses severity + scope in either order", () => {
    const a = parseRulesFromContent("- [ ] !warn @state A\n").rules[0];
    const b = parseRulesFromContent("- [ ] @state !warn B\n").rules[0];
    expect(a.severity).toBe("warn");
    expect(a.scope).toBe("state");
    expect(b.severity).toBe("warn");
    expect(b.scope).toBe("state");
  });

  it("extracts file scope from header parens", () => {
    const { rules } = parseRulesFromContent(
      "## Security (*.ts, *.js)\n- [ ] シークレット禁止\n",
    );
    expect(rules[0].filePatterns).toEqual(["*.ts", "*.js"]);
  });

  it("picks the LAST paren group when header has multiple parens", () => {
    const { rules } = parseRulesFromContent(
      "## Notes (draft) (*.md)\n- [ ] foo\n",
    );
    expect(rules[0].group).toBe("Notes (draft)");
    expect(rules[0].filePatterns).toEqual(["*.md"]);
  });

  it("flags empty checklist items", () => {
    const { errors } = parseRulesFromContent("- [ ]\n");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/empty rule/i);
  });

  it("flags unknown severity tags", () => {
    const { errors } = parseRulesFromContent("- [ ] !critical なにか\n");
    expect(errors.some((e) => /unknown severity/i.test(e.message))).toBe(true);
  });

  it("flags unclosed @state parens", () => {
    const { errors } = parseRulesFromContent("- [ ] @state(*.md foo\n");
    expect(errors.some((e) => /missing closing parenthesis/i.test(e.message))).toBe(true);
  });

  it("flags duplicate rules within the same group", () => {
    const content = "## G\n- [ ] 同じ\n- [ ] 同じ\n";
    const { errors } = parseRulesFromContent(content);
    expect(errors.some((e) => /duplicate rule/i.test(e.message))).toBe(true);
  });

  it("collects free-text as context", () => {
    const { context } = parseRulesFromContent("これは説明\n## G\n- [ ] rule\n");
    expect(context).toContain("これは説明");
  });
});

describe("matchGlob", () => {
  it("matches extensions at any depth", () => {
    expect(matchGlob("src/foo.ts", "*.ts")).toBe(true);
    expect(matchGlob("deep/nested/foo.ts", "*.ts")).toBe(true);
  });

  it("matches directory prefix at any depth (current behavior)", () => {
    expect(matchGlob("src/foo.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("app/src/foo.ts", "src/*.ts")).toBe(true);
  });

  it("** matches across path separators", () => {
    expect(matchGlob("a/b/c/x.test.ts", "**/*.test.ts")).toBe(true);
  });

  it("does not match mismatched extensions", () => {
    expect(matchGlob("foo.js", "*.ts")).toBe(false);
  });
});

describe("filterRulesByFiles", () => {
  it("keeps all rules when no file patterns", () => {
    const { rules } = parseRulesFromContent("- [ ] foo\n");
    expect(filterRulesByFiles(rules, ["x.py"])).toHaveLength(1);
  });

  it("drops rules whose file scope misses all changed files", () => {
    const { rules } = parseRulesFromContent("## A (*.ts)\n- [ ] foo\n");
    expect(filterRulesByFiles(rules, ["x.py"])).toHaveLength(0);
    expect(filterRulesByFiles(rules, ["x.ts"])).toHaveLength(1);
  });
});

describe("formatRulesForPrompt", () => {
  it("includes severity, scope, and also_consult meta", () => {
    const { rules } = parseRulesFromContent(
      "## Sec (*.ts)\n- [ ] !warn @state(README.md) チェック\n",
    );
    const text = formatRulesForPrompt(rules);
    expect(text).toContain("severity=WARNING");
    expect(text).toContain("scope=state");
    expect(text).toContain("also_consult=README.md");
    expect(text).toContain("applies to: *.ts");
  });
});
