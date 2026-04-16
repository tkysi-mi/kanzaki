import OpenAI from "openai";
import type { LLMProvider, ReviewResult } from "./types.js";

// ChatGPT OAuth時のベースURL（Codex CLIと同じ）
const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private useOAuth: boolean;

  constructor(apiKey: string, model: string, useOAuth = false) {
    this.apiKey = apiKey;
    this.model = model;
    this.useOAuth = useOAuth;
  }

  async review(systemPrompt: string, userPrompt: string): Promise<ReviewResult> {
    if (this.useOAuth) {
      return this.reviewWithCodexBackend(systemPrompt, userPrompt);
    }
    return this.reviewWithChatCompletions(systemPrompt, userPrompt);
  }

  private async reviewWithChatCompletions(systemPrompt: string, userPrompt: string): Promise<ReviewResult> {
    const client = new OpenAI({ apiKey: this.apiKey });
    const response = await client.chat.completions.create({
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

  private async reviewWithCodexBackend(systemPrompt: string, userPrompt: string): Promise<ReviewResult> {
    const url = `${CHATGPT_BASE_URL}/responses`;
    const body = {
      model: this.model,
      instructions: systemPrompt,
      input: [
        { role: "user", content: userPrompt },
      ],
      store: false,
      stream: true,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`${res.status} ${errorBody}`);
    }

    // SSEストリームからテキストを収集
    const content = await this.readSSEStream(res);

    return parseReviewResponse(content);
  }

  private async readSSEStream(res: Response): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let content = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          // response.output_text.delta イベントからテキストを収集
          if (event.type === "response.output_text.delta" && event.delta) {
            content += event.delta;
          }
        } catch {
          // JSON解析できないイベントはスキップ
        }
      }
    }

    if (!content) {
      throw new Error("OpenAI returned an empty response from stream.");
    }

    return content;
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
