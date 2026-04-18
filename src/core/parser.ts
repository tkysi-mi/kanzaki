import { readFileSync } from "node:fs";

export type Severity = "error" | "warn";
export type RuleScope = "diff" | "state";

export interface Rule {
  /** ルールが属するグループ (Markdownのヘッダー) */
  group: string;
  /** ルールのテキスト */
  text: string;
  /** 重要度: error = ブロック, warn = 警告のみ */
  severity: Severity;
  /** 対象ファイルのglobパターン（未指定=全ファイル対象） */
  filePatterns: string[];
  /** 判定スコープ: diff = 差分のみ, state = ファイル現状全体 */
  scope: RuleScope;
  /** scope=state のとき、追加で読み込む（変更されていない）ファイルのglobパターン */
  stateExtraPatterns: string[];
  /** このルールが定義された行番号 (1-indexed)、重複検出用 */
  lineNumber?: number;
}

export interface ParseError {
  /** エラーが発生した行番号 (1-indexed) */
  line: number;
  /** エラーまたは警告のメッセージ */
  message: string;
}

export interface ParsedRulesFile {
  /** パースされたルール一覧 */
  rules: Rule[];
  /** ルール以外の自由記述テキスト（LLMへのコンテキスト） */
  context: string;
  /** フォーマットエラー（あれば） */
  errors: ParseError[];
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
  const errors: ParseError[] = [];
  let currentGroup = "General";
  let currentPatterns: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNumber = i + 1;

    // ヘッダーを検出してグループ名とファイルパターンを更新
    const headerMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headerMatch) {
      const headerText = headerMatch[1].trim();
      const { name, patterns } = parseHeaderWithPatterns(headerText);
      currentGroup = name;
      currentPatterns = patterns;

      // 括弧の不一致を検出（閉じ括弧忘れ等）
      if (headerText.includes("(") && !headerText.includes(")")) {
        errors.push({
          line: lineNumber,
          message: `Missing closing parenthesis in file scope: "${headerText}"`,
        });
      }

      // 空の括弧を検出
      const emptyParenMatch = headerText.match(/\(\s*\)/);
      if (emptyParenMatch) {
        errors.push({
          line: lineNumber,
          message: `Empty file scope parentheses: "${headerText}". Remove "()" or specify glob patterns inside.`,
        });
      }
      continue;
    }

    // 空のチェックリスト項目を検出 (- [ ] の後にテキストなし)
    const emptyRuleMatch = trimmed.match(/^-\s*\[[\s]?\]\s*$/);
    if (emptyRuleMatch) {
      errors.push({
        line: lineNumber,
        message: `Empty rule. Checklist item has no text.`,
      });
      continue;
    }

    // チェックリスト項目を検出 (- [ ])
    const ruleMatch = trimmed.match(/^-\s*\[[\s]?\]\s+(.+)$/);
    if (ruleMatch) {
      const rawText = ruleMatch[1].trim();

      // 不正なseverityタグの検出（タイポ）
      const invalidTagMatch = rawText.match(
        /^!(err|warning|info|critical|block)\b/i,
      );
      if (invalidTagMatch) {
        errors.push({
          line: lineNumber,
          message: `Unknown severity tag "${invalidTagMatch[0]}". Use !error or !warn.`,
        });
      }

      // 不正な @state 構文（閉じ括弧忘れ）の検出
      const unclosedScopeMatch = rawText.match(/@state\s*\([^)]*$/i);
      if (unclosedScopeMatch) {
        errors.push({
          line: lineNumber,
          message: `Missing closing parenthesis in @state(...): "${rawText}"`,
        });
      }

      const parsed = parseRuleTags(rawText);

      // severityタグ直後に本文がない場合
      if (parsed.text.length === 0) {
        errors.push({
          line: lineNumber,
          message: `Empty rule. Checklist item has only tag(s) with no description.`,
        });
        continue;
      }

      // @state() のように空括弧
      if (parsed.scopeHasEmptyParens) {
        errors.push({
          line: lineNumber,
          message: `Empty @state() parentheses. Use "@state" alone or "@state(<glob>, ...)".`,
        });
      }

      rules.push({
        group: currentGroup,
        text: parsed.text,
        severity: parsed.severity,
        filePatterns: currentPatterns,
        scope: parsed.scope,
        stateExtraPatterns: parsed.stateExtraPatterns,
        lineNumber,
      });
      continue;
    }

    // それ以外の行の解析
    if (trimmed.length > 0) {
      // リスト項目の形式ミスの検出 (* [ ] や - [x] など)
      if (trimmed.match(/^[-*+]\s*\[(.*?)\]/)) {
        errors.push({
          line: lineNumber,
          message: `Invalid rule format. Checkbox must be '- [ ]'. Found: "${trimmed}"`,
        });
      }

      // 通常のコンテキストとして収集
      contextLines.push(trimmed);
    }
  }

  // 同一グループ内での重複ルールを検出
  const seen = new Map<string, number>();
  for (const rule of rules) {
    const key = `${rule.group}\u0000${rule.text.toLowerCase()}`;
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      errors.push({
        line: rule.lineNumber ?? 0,
        message: `Duplicate rule in group "${rule.group}" (first defined at line ${firstLine}): "${rule.text}"`,
      });
    } else {
      seen.set(key, rule.lineNumber ?? 0);
    }
  }

  return {
    rules,
    context: contextLines.join("\n"),
    errors,
  };
}

/**
 * ヘッダーテキストからグループ名とファイルパターンを分離する。
 * 例: "Security (*.ts, *.js)" → { name: "Security", patterns: ["*.ts", "*.js"] }
 *
 * 複数括弧がある場合は **最後** の括弧グループをファイルスコープと解釈する。
 * 例: "Notes (draft) (*.md)" → { name: "Notes (draft)", patterns: ["*.md"] }
 */
function parseHeaderWithPatterns(header: string): {
  name: string;
  patterns: string[];
} {
  // 貪欲マッチで末尾の `(...)` を拾う。内側に `(` `)` を含まないものに限定。
  const match = header.match(/^(.+)\s*\(([^()]+)\)\s*$/);
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
 * ルールテキストから severity (`!error` / `!warn`) と scope (`@state[(globs)]`) を抽出する。
 * タグの順序はどちらでもよく、混在も可。
 */
interface ParsedRuleTags {
  severity: Severity;
  scope: RuleScope;
  stateExtraPatterns: string[];
  text: string;
  scopeHasEmptyParens: boolean;
}

function parseRuleTags(rawText: string): ParsedRuleTags {
  let severity: Severity = "error";
  let scope: RuleScope = "diff";
  let stateExtraPatterns: string[] = [];
  let scopeHasEmptyParens = false;
  let text = rawText;

  // 先頭のタグ列をループで剥がす（順序自由）
  const severityRegex = /^!(error|warn)\b\s*/i;
  const scopeRegex = /^@state(?:\(([^)]*)\))?\s*/i;

  let progressed = true;
  while (progressed) {
    progressed = false;

    const sevMatch = text.match(severityRegex);
    if (sevMatch) {
      severity = sevMatch[1].toLowerCase() === "warn" ? "warn" : "error";
      text = text.slice(sevMatch[0].length);
      progressed = true;
      continue;
    }

    const scopeMatch = text.match(scopeRegex);
    if (scopeMatch) {
      scope = "state";
      const inside = scopeMatch[1];
      if (inside !== undefined) {
        const trimmedInside = inside.trim();
        if (trimmedInside.length === 0) {
          scopeHasEmptyParens = true;
        } else {
          stateExtraPatterns = trimmedInside
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
        }
      }
      text = text.slice(scopeMatch[0].length);
      progressed = true;
    }
  }

  return {
    severity,
    scope,
    stateExtraPatterns,
    text: text.trim(),
    scopeHasEmptyParens,
  };
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
    const fileScope =
      groupRules[0]?.filePatterns.length > 0
        ? ` (applies to: ${groupRules[0].filePatterns.join(", ")})`
        : "";
    sections.push(`### ${group}${fileScope}`);
    for (let i = 0; i < groupRules.length; i++) {
      const r = groupRules[i];
      const severity = r.severity === "warn" ? "WARNING" : "ERROR";
      const meta = [`severity=${severity}`, `scope=${r.scope}`];
      if (r.scope === "state" && r.stateExtraPatterns.length > 0) {
        meta.push(`also_consult=${r.stateExtraPatterns.join("|")}`);
      }
      sections.push(`- Rule #${i + 1} [${meta.join(", ")}]`);
      sections.push(`    text: ${r.text}`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

/**
 * 変更ファイル一覧に基づいてルールをフィルタリングする。
 * filePatterns が空のルールは全ファイルに適用される。
 */
export function filterRulesByFiles(
  rules: Rule[],
  changedFiles: string[],
): Rule[] {
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
 *
 * 注: `(^|/)` アンカーを使用するため、`src/*.ts` は任意の深さの `src/`
 * ディレクトリにマッチする（例: `app/src/foo.ts` も対象）。
 */
export function matchGlob(filePath: string, pattern: string): boolean {
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
