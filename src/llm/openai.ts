import OpenAI from "openai";
import type { LLMProvider, ReviewResult } from "./types.js";

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async review(systemPrompt: string, userPrompt: string): Promise<ReviewResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response.");
    }

    return parseReviewResponse(content);
  }
}

function parseReviewResponse(raw: string): ReviewResult {
  try {
    const parsed = JSON.parse(raw);

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
