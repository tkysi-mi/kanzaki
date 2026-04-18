import Anthropic from "@anthropic-ai/sdk";
import { parseReviewResponse } from "./parse.js";
import type { LLMProvider, RawReviewResult } from "./types.js";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async review(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<RawReviewResult> {
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

    return parseReviewResponse(textBlock.text, "Anthropic");
  }
}
