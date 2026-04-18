import type { KanzakiConfig } from "../config.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { ClaudeCliProvider } from "../llm/claude-cli.js";
import { OpenAIProvider } from "../llm/openai.js";
import type {
  LLMProvider,
  RawReviewResult,
  ReviewResult,
  Severity,
} from "../llm/types.js";
import type { FileContext, ReviewSource } from "./git.js";
import type { Rule } from "./parser.js";
import { formatRulesForPrompt } from "./parser.js";

const SYSTEM_PROMPT = `You are a strict quality reviewer. Your job is to review a set of changes (or a snapshot of files) against a checklist of rules defined by the user.

The rules may cover ANY domain — code, documentation, research, writing, presentations, design, or any other type of output. Evaluate each rule based on its intent, not just literal text matching.

Each rule is printed as:

    - Rule #N [severity=..., scope=..., (optional) also_consult=...]
        text: <the rule text>

The \`scope=\` field controls evaluation mode:
- scope=diff  → Judge whether THIS CHANGE introduces a new violation. Pre-existing violations that the change does not touch should NOT cause the rule to fail.
- scope=state → Judge whether the CURRENT STATE of the relevant files satisfies the rule, regardless of what was changed. Pre-existing violations SHOULD cause the rule to fail. Consult the full file contents, not just diff hunks.

The \`also_consult=\` field (pipe-separated globs) lists extra files included in the prompt for cross-file state checks (e.g. glossary, schema).

When returning results, the "rule" field MUST contain ONLY the text shown on the \`text:\` line — no "Rule #N" prefix, no severity/scope tags, no brackets, no numbering.

IMPORTANT:
- Rules marked [ERROR] are critical. Be strict when evaluating them.
- Rules marked [WARNING] are advisory. Be fair but flag clear violations.
- Only evaluate rules that are RELEVANT to the files under review. If a rule clearly does not apply, mark it as passed with reason "Not applicable."
- Use the context section (if provided) to understand the project's goals and constraints.
- If no diff is provided (files-only review), treat every rule as a state check against the provided files.

You MUST respond with valid JSON in this exact format:
{
  "results": [
    { "rule": "<exact rule text>", "passed": true, "reason": "<brief explanation>" },
    { "rule": "<exact rule text>", "passed": false, "reason": "<specific explanation of the violation>" }
  ],
  "summary": "<one-line overall summary>"
}`;

/**
 * 指定されたソース（staged/range/files等）をルールに照らしてLLMレビューする。
 */
export async function review(
  config: KanzakiConfig,
  rules: Rule[],
  source: ReviewSource,
  fileContexts: FileContext[],
  rulesContext?: string,
): Promise<ReviewResult> {
  const provider = createProvider(config);
  const userPrompt = buildUserPrompt(rules, source, fileContexts, rulesContext);

  const rawResult = await provider.review(SYSTEM_PROMPT, userPrompt);

  // ルール定義側のseverityを結果にマッピングする
  return mapSeverities(rawResult, rules);
}

function createProvider(config: KanzakiConfig): LLMProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config.apiKey, config.model, config.useOAuth);
    case "anthropic":
      if (config.useClaudeCli) {
        return new ClaudeCliProvider();
      }
      return new AnthropicProvider(config.apiKey, config.model);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

function buildUserPrompt(
  rules: Rule[],
  source: ReviewSource,
  fileContexts: FileContext[],
  rulesContext?: string,
): string {
  const parts: string[] = [];

  // ユーザー定義のコンテキスト（自由記述）
  if (rulesContext && rulesContext.trim().length > 0) {
    parts.push("## Project Context\n");
    parts.push(rulesContext);
    parts.push("");
  }

  // 起点情報
  parts.push(`## Review Source\n`);
  parts.push(`Source: ${source.label}`);
  if (source.kind === "files") {
    parts.push(
      "Mode: files-only (no diff). Evaluate each rule against the current state of the files below.",
    );
  }
  parts.push("");

  // ルール
  parts.push("## Checklist Rules\n");
  parts.push(formatRulesForPrompt(rules));

  // Diff
  if (source.diff.trim().length > 0) {
    parts.push("## Changes (git diff)\n");
    parts.push("```diff");
    parts.push(truncate(source.diff, 50_000));
    parts.push("```\n");
  }

  // ファイルコンテキスト
  if (fileContexts.length > 0) {
    parts.push("## Full File Context\n");
    parts.push(
      "The following are the full contents of the files under review:\n",
    );
    for (const ctx of fileContexts) {
      const ext = ctx.path.split(".").pop() ?? "";
      parts.push(`### ${ctx.path}\n`);
      parts.push(`\`\`\`${ext}`);
      parts.push(truncate(ctx.content, 20_000));
      parts.push("```\n");
    }
  }

  return parts.join("\n");
}

/**
 * LLMからの生レスポンス（severityなし）にルール定義側のseverityを付与して
 * ReviewResultへ昇格させる。ルールテキストのマッチングで紐付ける。
 */
function mapSeverities(result: RawReviewResult, rules: Rule[]): ReviewResult {
  const severityMap = new Map<string, Severity>();
  for (const rule of rules) {
    severityMap.set(rule.text.toLowerCase(), rule.severity);
  }

  return {
    ...result,
    results: result.results.map((r) => ({
      ...r,
      severity: severityMap.get(r.rule.toLowerCase()) ?? "error",
    })),
  };
}

/**
 * テキストを指定文字数で切り詰める。
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n... (truncated)";
}
