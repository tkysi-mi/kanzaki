import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ReviewResult, RuleResult } from "../llm/types.js";
import type { Rule } from "./parser.js";
import type { StagedChanges } from "./git.js";

/**
 * レビュー結果からコーディングエージェント向けのフィードバックmarkdownを生成し、
 * `{outputDir}/{timestamp}.md` に書き出す。違反が1件もなければ何もしない。
 */
export function writeFeedbackFile(
  result: ReviewResult,
  rules: Rule[],
  staged: StagedChanges,
  outputDir: string,
): string | null {
  const failures = result.results.filter((r) => !r.passed);
  if (failures.length === 0) return null;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const now = new Date();
  const filePath = join(outputDir, `${formatTimestamp(now)}.md`);
  const content = buildFeedbackMarkdown(failures, rules, staged, now, result.summary);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function buildFeedbackMarkdown(
  failures: RuleResult[],
  rules: Rule[],
  staged: StagedChanges,
  now: Date,
  summary: string,
): string {
  const ruleMap = new Map<string, Rule>();
  for (const r of rules) {
    ruleMap.set(r.text.toLowerCase(), r);
  }

  const errorCount = failures.filter((f) => f.severity === "error").length;
  const warnCount = failures.filter((f) => f.severity === "warn").length;

  const lines: string[] = [];
  lines.push(`# Kanzaki Review Feedback`);
  lines.push(``);
  lines.push(`Generated: ${now.toISOString()}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  if (summary) {
    lines.push(summary);
    lines.push(``);
  }
  lines.push(`- エラー: ${errorCount} 件`);
  lines.push(`- 警告: ${warnCount} 件`);
  lines.push(`- 変更ファイル: ${staged.files.join(", ")}`);
  lines.push(``);
  lines.push(`## Instructions for Coding Agents`);
  lines.push(``);
  lines.push(`以下は \`kanzaki check\` が検出したルール違反です。各違反について、指摘内容を読み、対象ファイルの該当箇所を修正してください。`);
  lines.push(`修正後は \`git add\` で再度ステージし、\`kanzaki check\` を実行して違反が解消されたことを確認してください。`);
  lines.push(`ルール定義そのものを変更することで違反を回避することは禁止されています（ルールの変更が必要な場合はユーザーに確認してください）。`);
  lines.push(``);
  lines.push(`## Violations`);
  lines.push(``);

  failures.forEach((f, idx) => {
    const rule = ruleMap.get(f.rule.toLowerCase());
    const tag = f.severity === "warn" ? "[WARN]" : "[ERROR]";
    lines.push(`### ${idx + 1}. ${tag} ${f.rule}`);
    lines.push(``);
    if (rule) {
      lines.push(`- **グループ**: ${rule.group}`);
      const scope = rule.filePatterns.length > 0 ? rule.filePatterns.join(", ") : "全ファイル";
      lines.push(`- **適用スコープ**: ${scope}`);
      if (rule.lineNumber) {
        lines.push(`- **ルール定義**: rules.md:${rule.lineNumber}`);
      }
    }
    lines.push(`- **変更ファイル**: ${staged.files.join(", ")}`);
    lines.push(``);
    lines.push(`**違反理由**:`);
    lines.push(``);
    const reason = f.reason.trim() || "(no reason provided)";
    for (const line of reason.split("\n")) {
      lines.push(`> ${line}`);
    }
    lines.push(``);
  });

  return lines.join("\n");
}

/**
 * Windows互換のタイムスタンプ文字列を生成する（コロン不使用）。
 * 例: "2026-04-16T14-30-45"
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}-${mo}-${da}T${h}-${mi}-${s}`;
}
