import { spawn } from "node:child_process";
import { parseReviewResponse } from "./parse.js";
import type { LLMProvider, RawReviewResult } from "./types.js";

/**
 * ローカルのClaude CLI (`claude -p`) をサブプロセスとして呼び出すプロバイダー。
 * OpenClawと同じ方式で、Claude CLIが認証・セッション管理を担当する。
 */
export class ClaudeCliProvider implements LLMProvider {
  async review(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<RawReviewResult> {
    // systemとuserを1つのプロンプトに結合してstdinで渡す
    const combinedPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

    const output = await this.runClaudeCli(combinedPrompt);
    return parseReviewResponse(output, "Claude CLI");
  }

  private runClaudeCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Node.js 20+ の Windows では .cmd/.bat を直接 spawn できない
      // (CVE-2024-27980 対応)。`shell:true` は DEP0190 を引き起こすため、
      // cmd.exe 自体を spawn し、その中で claude を起動する。
      // cmd.exe は .exe なので spawn の制限に該当しない。
      const isWin = process.platform === "win32";
      const child = isWin
        ? spawn("cmd.exe", ["/d", "/s", "/c", "claude -p"], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsVerbatimArguments: true,
          })
        : spawn("claude", ["-p"], {
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
          reject(
            new Error(
              `claude CLI exited with code ${code}: ${stderr || stdout}`,
            ),
          );
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
