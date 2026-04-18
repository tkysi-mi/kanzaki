export type Severity = "error" | "warn";

/** LLMから返された生のルール判定。severityは未確定。 */
export interface RawRuleResult {
  /** ルールテキスト */
  rule: string;
  /** パスしたかどうか */
  passed: boolean;
  /** 判定理由 */
  reason: string;
}

/** LLMから返された生のレビュー結果。severity付与前。 */
export interface RawReviewResult {
  results: RawRuleResult[];
  summary: string;
}

export interface RuleResult extends RawRuleResult {
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
  /** プロンプトを送信し、LLMからの生レビュー結果を取得する（severityはreviewer層で付与） */
  review(systemPrompt: string, userPrompt: string): Promise<RawReviewResult>;
}
