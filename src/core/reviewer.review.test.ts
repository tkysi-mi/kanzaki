import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KanzakiConfig } from "../config.js";

const hoisted = vi.hoisted(() => {
  const reviewMock = vi.fn();
  const openaiCtor = vi.fn();
  const anthropicCtor = vi.fn();
  const claudeCliCtor = vi.fn();
  return { reviewMock, openaiCtor, anthropicCtor, claudeCliCtor };
});

vi.mock("../llm/openai.js", () => ({
  OpenAIProvider: class {
    review = hoisted.reviewMock;
    constructor(...args: unknown[]) {
      hoisted.openaiCtor(...args);
    }
  },
}));
vi.mock("../llm/anthropic.js", () => ({
  AnthropicProvider: class {
    review = hoisted.reviewMock;
    constructor(...args: unknown[]) {
      hoisted.anthropicCtor(...args);
    }
  },
}));
vi.mock("../llm/claude-cli.js", () => ({
  ClaudeCliProvider: class {
    review = hoisted.reviewMock;
    constructor(...args: unknown[]) {
      hoisted.claudeCliCtor(...args);
    }
  },
}));

const { review } = await import("./reviewer.js");
const { parseRulesFromContent } = await import("./parser.js");

const baseConfig: KanzakiConfig = {
  provider: "openai",
  apiKey: "k",
  model: "m",
  rulesPath: "rules.md",
  verbose: false,
  noBlock: false,
  useOAuth: false,
  useClaudeCli: false,
};

const rules = parseRulesFromContent("- [ ] !warn short\n").rules;
const source = {
  kind: "staged" as const,
  label: "staged",
  diff: "",
  files: [],
};

beforeEach(() => {
  hoisted.reviewMock.mockReset();
  hoisted.openaiCtor.mockClear();
  hoisted.anthropicCtor.mockClear();
  hoisted.claudeCliCtor.mockClear();
});

describe("review()", () => {
  it("wires OpenAI provider and maps severities on the response", async () => {
    hoisted.reviewMock.mockResolvedValue({
      results: [{ rule: "short", passed: false, reason: "too long" }],
      summary: "one issue",
    });
    const out = await review(baseConfig, rules, source, []);
    expect(hoisted.openaiCtor).toHaveBeenCalledWith("k", "m", false);
    expect(hoisted.reviewMock).toHaveBeenCalledOnce();
    expect(out.results[0].severity).toBe("warn");
    expect(out.summary).toBe("one issue");
  });

  it("uses AnthropicProvider when provider=anthropic and claude-cli disabled", async () => {
    hoisted.reviewMock.mockResolvedValue({ results: [], summary: "" });
    await review({ ...baseConfig, provider: "anthropic" }, rules, source, []);
    expect(hoisted.anthropicCtor).toHaveBeenCalledWith("k", "m");
    expect(hoisted.claudeCliCtor).not.toHaveBeenCalled();
  });

  it("uses ClaudeCliProvider when useClaudeCli is set", async () => {
    hoisted.reviewMock.mockResolvedValue({ results: [], summary: "" });
    await review(
      { ...baseConfig, provider: "anthropic", useClaudeCli: true },
      rules,
      source,
      [],
    );
    expect(hoisted.claudeCliCtor).toHaveBeenCalledOnce();
    expect(hoisted.anthropicCtor).not.toHaveBeenCalled();
  });

  it("throws for unknown provider", async () => {
    await expect(
      review(
        { ...baseConfig, provider: "bogus" as KanzakiConfig["provider"] },
        rules,
        source,
        [],
      ),
    ).rejects.toThrow(/Unknown provider/);
  });

  it("passes built user prompt down to the provider", async () => {
    hoisted.reviewMock.mockResolvedValue({ results: [], summary: "" });
    await review(baseConfig, rules, source, [], "ctx info");
    const [, userPrompt] = hoisted.reviewMock.mock.calls[0];
    expect(userPrompt).toContain("## Project Context");
    expect(userPrompt).toContain("ctx info");
    expect(userPrompt).toContain("## Checklist Rules");
  });
});
