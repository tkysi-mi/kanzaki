import { readFileSync } from "node:fs";

export type Severity = "error" | "warn";

export interface Rule {
  /** ルールが属するグループ (Markdownのヘッダー) */
  group: string;
  /** ルールのテキスト */
  text: string;
  /** 重要度: error = ブロック, warn = 警告のみ */
  severity: Severity;
  /** 対象ファイルのglobパターン（未指定=全ファイル対象） */
  filePatterns: string[];
}

export interface ParsedRulesFile {
  /** パースされたルール一覧 */
  rules: Rule[];
  /** ルール以外の自由記述テキスト（LLMへのコンテキスト） */
  context: string;
}

/**
 * .kanzaki.md ファイルを解析し、ルールとコンテキストを抽出する。
 *
 * 対応形式:
 * - `- [ ] ルールテキスト`          → severity: error (デフォルト)
 * - `- [ ] !error ルールテキスト`   → severity: error (明示)
 * - `- [ ] !warn ルールテキスト`    → severity: warn
 *
 * ヘッダー（##）はグループ名として使用される。
 * ヘッダーに括弧でglobパターンを指定可能:
 * - `## Security (*.ts, *.js)` → このグループのルールは .ts/.js ファイルのみに適用
 *
 * チェックリスト項目でもヘッダーでもない行は「コンテキスト」として収集される。
 */
export function parseRulesFile(filePath: string): ParsedRulesFile {
  const content = readFileSync(filePath, "utf-8");
  return parseRulesFromContent(content);
}

export function parseRulesFromContent(content: string): ParsedRulesFile {
  const lines = content.split("\n");
  const rules: Rule[] = [];
  const contextLines: string[] = [];
  let currentGroup = "General";
  let currentPatterns: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // ヘッダーを検出してグループ名とファイルパターンを更新
    const headerMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headerMatch) {
      const { name, patterns } = parseHeaderWithPatterns(headerMatch[1].trim());
      currentGroup = name;
      currentPatterns = patterns;
      continue;
    }

    // チェックリスト項目を検出
    const ruleMatch = trimmed.match(/^-\s*\[[\s]?\]\s+(.+)$/);
    if (ruleMatch) {
      const rawText = ruleMatch[1].trim();
      const { severity, text } = parseSeverity(rawText);
      rules.push({
        group: currentGroup,
        text,
        severity,
        filePatterns: currentPatterns,
      });
      continue;
    }

    // それ以外の非空行はコンテキストとして収集
    if (trimmed.length > 0) {
      contextLines.push(trimmed);
    }
  }

  return {
    rules,
    context: contextLines.join("\n"),
  };
}

/**
 * ヘッダーテキストからグループ名とファイルパターンを分離する。
 * 例: "Security (*.ts, *.js)" → { name: "Security", patterns: ["*.ts", "*.js"] }
 */
function parseHeaderWithPatterns(header: string): { name: string; patterns: string[] } {
  const match = header.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (match) {
    const name = match[1].trim();
    const patterns = match[2]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return { name, patterns };
  }

  return { name: header, patterns: [] };
}

/**
 * ルールテキストから重要度プレフィックスを抽出する。
 * `!error` / `!warn` が先頭にあればそれを使い、なければデフォルト error。
 */
function parseSeverity(rawText: string): { severity: Severity; text: string } {
  const warnMatch = rawText.match(/^!warn\s+(.+)$/i);
  if (warnMatch) {
    return { severity: "warn", text: warnMatch[1].trim() };
  }

  const errorMatch = rawText.match(/^!error\s+(.+)$/i);
  if (errorMatch) {
    return { severity: "error", text: errorMatch[1].trim() };
  }

  return { severity: "error", text: rawText };
}

/**
 * ルール配列をLLMプロンプト用のフォーマット文字列に変換する。
 */
export function formatRulesForPrompt(rules: Rule[]): string {
  const grouped = new Map<string, Rule[]>();

  for (const rule of rules) {
    const group = grouped.get(rule.group) ?? [];
    group.push(rule);
    grouped.set(rule.group, group);
  }

  const sections: string[] = [];
  for (const [group, groupRules] of grouped) {
    const scope = groupRules[0]?.filePatterns.length > 0
      ? ` (applies to: ${groupRules[0].filePatterns.join(", ")})`
      : "";
    sections.push(`### ${group}${scope}`);
    for (let i = 0; i < groupRules.length; i++) {
      const r = groupRules[i];
      const tag = r.severity === "warn" ? "[WARNING]" : "[ERROR]";
      sections.push(`${i + 1}. ${tag} ${r.text}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * 変更ファイル一覧に基づいてルールをフィルタリングする。
 * filePatterns が空のルールは全ファイルに適用される。
 */
export function filterRulesByFiles(rules: Rule[], changedFiles: string[]): Rule[] {
  return rules.filter((rule) => {
    // パターン未指定 → 全ファイル対象
    if (rule.filePatterns.length === 0) return true;

    // いずれかの変更ファイルがパターンにマッチすれば適用
    return changedFiles.some((file) =>
      rule.filePatterns.some((pattern) => matchGlob(file, pattern)),
    );
  });
}

/**
 * シンプルなglobマッチング。
 * *.ts, *.md, docs/*, **\/*.test.ts 等の基本パターンに対応。
 */
function matchGlob(filePath: string, pattern: string): boolean {
  // パターンを正規表現に変換
  const regexStr = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{DOUBLE_STAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{DOUBLE_STAR}}/g, ".*")
    .replace(/\?/g, "[^/]");

  const regex = new RegExp(`(^|/)${regexStr}$`, "i");
  return regex.test(filePath);
}

// 後方互換: 旧APIを維持
export function parseRules(filePath: string): Rule[] {
  return parseRulesFile(filePath).rules;
}
