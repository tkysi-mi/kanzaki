import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { loadCredentials, getActiveApiKey } from "./auth.js";

export interface KanzakiConfig {
  provider: "openai" | "anthropic";
  apiKey: string;
  model: string;
  rulesPath: string;
  verbose: boolean;
  noBlock: boolean;
  /** ChatGPT OAuth認証を使用しているか */
  useOAuth: boolean;
  /** Claude CLIをサブプロセスとして利用するか */
  useClaudeCli: boolean;
}

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-5.4",
  anthropic: "claude-sonnet-4-20250514",
};

/**
 * CLI引数とenv変数からKanzaki設定をロードする。
 * 優先順位: CLIフラグ → env変数 → 保存済みクレデンシャル
 */
export function loadConfig(overrides: Partial<KanzakiConfig> = {}): KanzakiConfig {
  // .env ファイルがあれば読み込む
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  // 保存済みクレデンシャルを読み込む
  const stored = loadCredentials();

  const provider = (
    overrides.provider
    ?? process.env.KANZAKI_PROVIDER
    ?? stored?.provider
    ?? "openai"
  ) as KanzakiConfig["provider"];

  // APIキー解決: CLIフラグ → env → 保存済み
  let apiKey = overrides.apiKey ?? process.env.KANZAKI_API_KEY ?? "";
  if (!apiKey && stored) {
    apiKey = getActiveApiKey(stored);
  }
  if (!apiKey) {
    throw new Error(
      "API key is required. Run 'kanzaki login' or set KANZAKI_API_KEY environment variable.",
    );
  }

  const model = overrides.model ?? process.env.KANZAKI_MODEL ?? DEFAULT_MODELS[provider] ?? "gpt-5.4";

  const rulesPath = overrides.rulesPath ?? process.env.KANZAKI_RULES_PATH ?? ".kanzaki/rules.md";

  return {
    provider,
    apiKey,
    model,
    rulesPath: resolve(process.cwd(), rulesPath),
    verbose: overrides.verbose ?? false,
    noBlock: overrides.noBlock ?? false,
    useOAuth: !!(stored?.oauthToken),
    useClaudeCli: !!(stored?.useClaudeCli),
  };
}
