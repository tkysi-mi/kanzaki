import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, ReviewResult } from "./types.js";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async review(systemPrompt: string, userPrompt: string): Promise<ReviewResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("Anthropic returned no text content.");
    }

    return parseReviewResponse(textBlock.text);
  }
}

function parseReviewResponse(raw: string): ReviewResult {
  // Anthropicはコードブロック内にJSONを返すことがあるため、抽出を試みる
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

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
    throw new Error(`Failed to parse LLM response as JSON:\n${raw}\n\n${error}`);
  }
}
