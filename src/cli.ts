import { Command } from "commander";
import chalk from "chalk";
import { existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";

import { loadConfig } from "./config.js";
import { parseRulesFile, filterRulesByFiles } from "./core/parser.js";
import { getStagedChanges, getFileContexts, hasStagedChanges, getRepoRoot } from "./core/git.js";
import { review } from "./core/reviewer.js";
import { report } from "./core/reporter.js";
import {
  saveCredentials,
  clearCredentials,
  loadCredentials,
  hasCredentials,
  requestDeviceCode,
  pollForToken,
} from "./auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createCli(): Command {
  const program = new Command();

  program
    .name("kanzaki")
    .description("LLM-powered semantic pre-commit linter")
    .version("0.1.0");

  // ── init ──────────────────────────────────────────────
  program
    .command("init")
    .description("Create .kanzaki.md rules file")
    .action(async () => {
      const cwd = process.cwd();

      // ルールファイル作成
      const rulesPath = resolve(cwd, ".kanzaki.md");
      if (existsSync(rulesPath)) {
        console.log(chalk.yellow("⚠ .kanzaki.md already exists, skipping."));
      } else {
        const template = loadTemplate();
        writeFileSync(rulesPath, template, "utf-8");
        console.log(chalk.green("✓ Created .kanzaki.md"));
      }

      console.log();
      console.log(chalk.dim("Edit .kanzaki.md to customize your review rules."));
      console.log(chalk.dim("You can run 'kanzaki check' directly, or set it up with husky/lint-staged."));
      console.log(chalk.dim("Run 'kanzaki login' to authenticate."));
    });

  // ── check ─────────────────────────────────────────────
  program
    .command("check")
    .description("Review staged changes against rules")
    .option("-p, --provider <provider>", "LLM provider (openai / anthropic)")
    .option("-m, --model <model>", "Model name")
    .option("-r, --rules <path>", "Path to rules file", ".kanzaki.md")
    .option("--api-key <key>", "API key (prefer KANZAKI_API_KEY env var)")
    .option("--no-block", "Warn only, don't block commit")
    .option("-v, --verbose", "Verbose output")
    .action(async (opts) => {
      try {
        // ステージされた変更の確認
        if (!hasStagedChanges()) {
          console.log(chalk.yellow("No staged changes found. Nothing to review."));
          process.exit(0);
        }

        // 設定ロード
        const config = loadConfig({
          provider: opts.provider,
          apiKey: opts.apiKey,
          model: opts.model,
          rulesPath: opts.rules,
          verbose: opts.verbose ?? false,
          noBlock: opts.noBlock === false, // commander の --no-block は block=false にする
        });

        // ルールファイルの存在確認
        if (!existsSync(config.rulesPath)) {
          console.error(chalk.red(`Rules file not found: ${config.rulesPath}`));
          console.error(chalk.dim("Run 'kanzaki init' to create one."));
          process.exit(1);
        }

        // ルール解析
        const { rules, context: rulesContext } = parseRulesFile(config.rulesPath);
        if (rules.length === 0) {
          console.log(chalk.yellow("No rules found in rules file. Skipping review."));
          process.exit(0);
        }

        const errorRules = rules.filter((r) => r.severity === "error").length;
        const warnRules = rules.filter((r) => r.severity === "warn").length;

        if (config.verbose) {
          console.log(chalk.dim(`Provider: ${config.provider} (${config.model})`));
          console.log(chalk.dim(`Rules: ${errorRules} errors, ${warnRules} warnings`));
          if (rulesContext) {
            console.log(chalk.dim(`Context: ${rulesContext.length} chars of additional context`));
          }
        }

        // diff取得
        const staged = getStagedChanges();
        const fileContexts = getFileContexts(staged.files);

        // ファイルスコープでルールをフィルタリング
        const applicableRules = filterRulesByFiles(rules, staged.files);

        if (applicableRules.length === 0) {
          console.log(chalk.yellow("No applicable rules for changed files. Skipping review."));
          process.exit(0);
        }

        if (config.verbose) {
          console.log(chalk.dim(`Files changed: ${staged.files.join(", ")}`));
          if (applicableRules.length < rules.length) {
            console.log(chalk.dim(`Rules filtered: ${applicableRules.length}/${rules.length} applicable`));
          }
        }

        // LLMレビュー
        console.log(chalk.dim("Reviewing changes with LLM..."));
        const result = await review(config, applicableRules, staged, fileContexts, rulesContext);

        // 結果表示
        const { errorCount } = report(result, config.verbose);

        // errorのみブロック（warnはブロックしない）
        if (errorCount > 0 && !config.noBlock) {
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });

  // ── login ─────────────────────────────────────────────
  program
    .command("login")
    .description("Authenticate with OpenAI or Anthropic")
    .option("--oauth", "Use OAuth Device Flow (OpenAI subscription)")
    .option("-p, --provider <provider>", "Provider: openai or anthropic", "openai")
    .action(async (opts) => {
      const provider = opts.provider as "openai" | "anthropic";

      if (opts.oauth) {
        // OAuth Device Flow
        if (provider !== "openai") {
          console.error(chalk.red("OAuth is currently only supported for OpenAI."));
          process.exit(1);
        }

        console.log(chalk.dim("Starting OAuth Device Flow..."));
        try {
          const deviceCode = await requestDeviceCode();
          console.log();
          console.log(chalk.bold("Open this URL in your browser:"));
          console.log(chalk.cyan.underline(deviceCode.verification_uri_complete || deviceCode.verification_uri));
          console.log();
          console.log(`Enter code: ${chalk.bold.yellow(deviceCode.user_code)}`);
          console.log(chalk.dim("Waiting for authorization..."));

          const token = await pollForToken(
            deviceCode.device_code,
            deviceCode.interval,
            deviceCode.expires_in,
          );

          const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();
          saveCredentials({
            provider: "openai",
            apiKey: "",
            oauthToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt,
          });

          console.log(chalk.green("\n✓ Authenticated via OAuth"));
        } catch (error) {
          console.error(chalk.red(`OAuth failed: ${(error as Error).message}`));
          console.error(chalk.dim("Try 'kanzaki login' with an API key instead."));
          process.exit(1);
        }
      } else {
        // API Key入力
        const key = await promptSecret(
          `Enter your ${provider === "openai" ? "OpenAI" : "Anthropic"} API key: `,
        );

        if (!key) {
          console.error(chalk.red("No API key provided."));
          process.exit(1);
        }

        saveCredentials({ provider, apiKey: key });
        console.log(chalk.green(`✓ Saved ${provider} credentials`));
        console.log(chalk.dim("Credentials stored in ~/.config/kanzaki/credentials.json"));
      }
    });

  // ── logout ────────────────────────────────────────────
  program
    .command("logout")
    .description("Remove saved credentials")
    .action(() => {
      clearCredentials();
      console.log(chalk.green("✓ Credentials removed"));
    });

  // ── status ────────────────────────────────────────────
  program
    .command("status")
    .description("Show authentication status")
    .action(() => {
      const creds = loadCredentials();
      if (!creds || (!creds.apiKey && !creds.oauthToken)) {
        console.log(chalk.yellow("Not authenticated."));
        console.log(chalk.dim("Run 'kanzaki login' to authenticate."));
        return;
      }

      console.log(chalk.bold("Kanzaki Status"));
      console.log(`  Provider: ${chalk.cyan(creds.provider)}`);

      if (creds.oauthToken) {
        const expired = creds.expiresAt && new Date(creds.expiresAt) < new Date();
        console.log(`  Auth: ${chalk.cyan("OAuth")}${expired ? chalk.red(" (expired)") : chalk.green(" (active)")}`);
      } else {
        const masked = creds.apiKey.slice(0, 7) + "..." + creds.apiKey.slice(-4);
        console.log(`  Auth: ${chalk.cyan("API Key")} (${masked})`);
      }
    });

  return program;
}

function loadTemplate(): string {
  // まずパッケージ内のtemplateを試す
  const templatePath = resolve(__dirname, "..", "templates", "rules.md");
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, "utf-8");
  }

  // フォールバック: デフォルトテンプレート
  return `# Kanzaki レビュールール

## 品質
- [ ] !error 変更内容がプロジェクトの既存のスタイルや規約と一貫していること
- [ ] !error プレースホルダーやTODOが残っていないこと
- [ ] !warn 内容が明確・簡潔で、不要な繰り返しがないこと

## 正確性
- [ ] !error 事実誤認や誤解を招く情報が含まれていないこと
- [ ] !warn 適切な箇所に出典・参考文献が記載されていること

## セキュリティ (*.ts, *.js, *.py)
- [ ] !error ハードコードされたシークレット・APIキー・パスワードが含まれていないこと
`;
}

/**
 * ターミナルでAPIキーを安全に入力させる（入力は非表示）。
 */
function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // 入力を非表示にする
    process.stdout.write(prompt);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (stdin.isTTY && stdin.setRawMode) {
      stdin.setRawMode(true);
    }

    let input = "";
    const onData = (char: Buffer) => {
      const c = char.toString();
      if (c === "\n" || c === "\r") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY && stdin.setRawMode) {
          stdin.setRawMode(wasRaw ?? false);
        }
        process.stdout.write("\n");
        rl.close();
        resolve(input);
      } else if (c === "\x03") {
        // Ctrl+C
        process.exit(1);
      } else if (c === "\x7f" || c === "\b") {
        // Backspace
        input = input.slice(0, -1);
      } else {
        input += c;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

