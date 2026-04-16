import { spawn, execSync } from "node:child_process";
import type { LLMProvider, ReviewResult } from "./types.js";

/**
 * ローカルのClaude CLI (`claude -p`) をサブプロセスとして呼び出すプロバイダー。
 * OpenClawと同じ方式で、Claude CLIが認証・セッション管理を担当する。
 */
export class ClaudeCliProvider implements LLMProvider {
  async review(systemPrompt: string, userPrompt: string): Promise<ReviewResult> {
    // systemとuserを1つのプロンプトに結合してstdinで渡す
    const combinedPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const output = await this.runClaudeCli(combinedPrompt);
    return parseReviewResponse(output);
  }

  private runClaudeCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Node.js 20+ の Windows では spawn(shell:false) が PATHEXT 経由で
      // .cmd を解決しないため、事前にフルパスへ解決する
      const command = resolveClaudeBinary();
      const child = spawn(command, ["-p"], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err) => {
        reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`claude CLI exited with code ${code}: ${stderr || stdout}`));
          return;
        }
        resolve(stdout);
      });

      // プロンプトをstdinに書き込んで閉じる
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

/**
 * Claude CLI の実行ファイルパスを解決する。
 * Windows では `where claude` の結果から `.cmd`（npm globalのshim）を優先して返す。
 * 解決に失敗した場合はフォールバックとして "claude" / "claude.cmd" を返す。
 */
function resolveClaudeBinary(): string {
  if (process.platform !== "win32") return "claude";

  try {
    const output = execSync("where claude", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const candidates = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    const cmdPath = candidates.find((line) => line.toLowerCase().endsWith(".cmd"));
    if (cmdPath) return cmdPath;

    const exePath = candidates.find((line) => line.toLowerCase().endsWith(".exe"));
    if (exePath) return exePath;

    if (candidates[0]) return candidates[0];
  } catch {
    // `where claude` が失敗した場合はフォールバックに任せる
  }

  return "claude.cmd";
}

function parseReviewResponse(raw: string): ReviewResult {
  // Claude CLIはコードブロック内にJSONを返すことがあるため抽出を試みる
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
    throw new Error(`Failed to parse Claude CLI response as JSON:\n${raw}\n\n${error}`);
  }
}
