export type Severity = "error" | "warn";

export interface RuleResult {
  /** ルールテキスト */
  rule: string;
  /** パスしたかどうか */
  passed: boolean;
  /** 判定理由 */
  reason: string;
  /** 重要度 (LLMからの返却ではなく、ルール定義側から付与) */
  severity: Severity;
}

export interface ReviewResult {
  /** 各ルールの判定結果 */
  results: RuleResult[];
  /** 全体サマリー */
  summary: string;
}

export interface LLMProvider {
  /** プロンプトを送信し、レビュー結果を取得する */
  review(systemPrompt: string, userPrompt: string): Promise<ReviewResult>;
}
