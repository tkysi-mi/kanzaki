import type { KanzakiConfig } from "../config.js";
import type { Rule } from "./parser.js";
import { formatRulesForPrompt } from "./parser.js";
import type { FileContext, StagedChanges } from "./git.js";
import type { LLMProvider, ReviewResult, Severity } from "../llm/types.js";
import { OpenAIProvider } from "../llm/openai.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { ClaudeCliProvider } from "../llm/claude-cli.js";

const SYSTEM_PROMPT = `You are a strict quality reviewer. Your job is to review changes (git diff) against a checklist of rules defined by the user.

The rules may cover ANY domain — code, documentation, research, writing, presentations, design, or any other type of output. Evaluate each rule based on its intent, not just literal text matching.

For each rule in the checklist, determine whether the staged changes comply with it.

IMPORTANT:
- Rules marked [ERROR] are critical. Be strict when evaluating them.
- Rules marked [WARNING] are advisory. Be fair but flag clear violations.
- Only evaluate rules that are RELEVANT to the changes. If a rule clearly does not apply to the content being changed, mark it as passed with reason "Not applicable to these changes."
- Use the context section (if provided) to understand the project's goals and constraints.
- Look at both the diff AND the full file context to make accurate judgments.

You MUST respond with valid JSON in this exact format:
{
  "results": [
    { "rule": "<exact rule text>", "passed": true, "reason": "<brief explanation>" },
    { "rule": "<exact rule text>", "passed": false, "reason": "<specific explanation of the violation>" }
  ],
  "summary": "<one-line overall summary>"
}`;

/**
 * ステージされた変更をルールに照らし合わせてLLMでレビューする。
 */
export async function review(
  config: KanzakiConfig,
  rules: Rule[],
  staged: StagedChanges,
  fileContexts: FileContext[],
  rulesContext?: string,
): Promise<ReviewResult> {
  const provider = createProvider(config);
  const userPrompt = buildUserPrompt(rules, staged, fileContexts, rulesContext);

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
  staged: StagedChanges,
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

  // ルール
  parts.push("## Checklist Rules\n");
  parts.push(formatRulesForPrompt(rules));

  // Diff
  parts.push("## Staged Changes (git diff)\n");
  parts.push("```diff");
  parts.push(truncate(staged.diff, 50_000));
  parts.push("```\n");

  // ファイルコンテキスト
  if (fileContexts.length > 0) {
    parts.push("## Full File Context\n");
    parts.push("The following are the full contents of modified files for additional context:\n");
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
 * LLMレスポンスのresultsにルール定義側のseverityを付与する。
 * ルールテキストのマッチングで紐付ける。
 */
function mapSeverities(result: ReviewResult, rules: Rule[]): ReviewResult {
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
