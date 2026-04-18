import type { RawReviewResult } from "./types.js";

/**
 * LLMレスポンスのrawテキストをRawReviewResultにパースする。
 * コードフェンス（```json ... ```）があれば中身を取り出し、無ければ全体をJSONとして扱う。
 * severityは付与しない（reviewer層でルール定義から紐付ける）。
 *
 * @param raw LLMから返された生テキスト
 * @param sourceLabel エラーメッセージに使うラベル（例: "OpenAI", "Anthropic", "Claude CLI"）
 */
export function parseReviewResponse(raw: string, sourceLabel = "LLM"): RawReviewResult {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim();

  try {
    const parsed = JSON.parse(jsonStr);

    if (!Array.isArray(parsed.results)) {
      throw new Error("Response missing 'results' array.");
    }

    return {
      results: parsed.results.map((r: Record<string, unknown>) => ({
        rule: String(r.rule ?? ""),
        passed: Boolean(r.passed),
        reason: String(r.reason ?? ""),
      })),
      summary: String(parsed.summary ?? ""),
    };
  } catch (error) {
    throw new Error(`Failed to parse ${sourceLabel} response as JSON:\n${raw}\n\n${error}`);
  }
}
