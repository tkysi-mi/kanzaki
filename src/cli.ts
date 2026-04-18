import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pc from "picocolors";
import {
  clearCredentials,
  loadCredentials,
  loginWithOAuthPKCE,
  saveCredentials,
} from "./auth.js";
import { loadConfig } from "./config.js";
import { writeFeedbackFile } from "./core/feedback.js";
import {
  getFileContextsForSource,
  getReviewSource,
  hasStagedChanges,
  listTrackedFiles,
  type ReviewSourceKind,
} from "./core/git.js";
import {
  filterRulesByFiles,
  matchGlob,
  parseRulesFile,
  type Rule,
} from "./core/parser.js";
import { report } from "./core/reporter.js";
import { review } from "./core/reviewer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createCli(): Command {
  const program = new Command();

  program
    .name("kanzaki")
    .description("LLM-powered semantic pre-commit linter")
    .version("0.3.0");

  // ── init ──────────────────────────────────────────────
  program
    .command("init")
    .description("Create .kanzaki/rules.md rules file")
    .action(async () => {
      const cwd = process.cwd();

      // ルールファイル作成
      const rulesPath = resolve(cwd, ".kanzaki", "rules.md");
      const rulesDir = dirname(rulesPath);

      if (!existsSync(rulesDir)) {
        mkdirSync(rulesDir, { recursive: true });
      }

      if (existsSync(rulesPath)) {
        console.log(pc.yellow("⚠ .kanzaki/rules.md already exists, skipping."));
      } else {
        const template = loadTemplate();
        writeFileSync(rulesPath, template, "utf-8");
        console.log(pc.green("✓ Created .kanzaki/rules.md"));
      }

      // reviewsフォルダ（フィードバック出力先）はGit管理対象外にする
      const kanzakiGitignore = resolve(rulesDir, ".gitignore");
      if (!existsSync(kanzakiGitignore)) {
        writeFileSync(kanzakiGitignore, "reviews/\n", "utf-8");
        console.log(pc.green("✓ Created .kanzaki/.gitignore"));
      }

      console.log();
      console.log(
        pc.dim("Edit .kanzaki/rules.md to customize your review rules."),
      );
      console.log(
        pc.dim(
          "You can run 'kanzaki check' directly, or set it up with husky/lint-staged.",
        ),
      );
      console.log(pc.dim("Run 'kanzaki login' to authenticate."));
    });

  // ── check ─────────────────────────────────────────────
  program
    .command("check")
    .description("Review changes against rules")
    .option("-p, --provider <provider>", "LLM provider (openai / anthropic)")
    .option("-m, --model <model>", "Model name")
    .option("-r, --rules <path>", "Path to rules file", ".kanzaki/rules.md")
    .option("--api-key <key>", "API key (prefer KANZAKI_API_KEY env var)")
    .option("--no-block", "Warn only, don't block commit")
    .option(
      "-o, --emit-feedback",
      "Write feedback markdown (for coding agents) to .kanzaki/reviews/",
    )
    .option("-v, --verbose", "Verbose output")
    .option(
      "--working-tree",
      "Review working tree changes against HEAD (staged + unstaged)",
    )
    .option(
      "--range <range>",
      "Review diff for a revision range (e.g. main..HEAD)",
    )
    .option(
      "--files <paths...>",
      "Review current state of the specified files (no diff)",
    )
    .action(async (opts) => {
      try {
        // 起点オプションの相互排他チェック
        const sourceFlagsUsed = [
          opts.workingTree ? "--working-tree" : null,
          opts.range ? "--range" : null,
          opts.files ? "--files" : null,
        ].filter((v): v is string => v !== null);

        if (sourceFlagsUsed.length > 1) {
          console.error(
            pc.red(
              `Cannot combine ${sourceFlagsUsed.join(" and ")}. Choose exactly one source.`,
            ),
          );
          process.exit(1);
        }

        const sourceKind: ReviewSourceKind = opts.workingTree
          ? "workingTree"
          : opts.range
            ? "range"
            : opts.files
              ? "files"
              : "staged";

        // stagedモードのみ、早期終了チェック
        if (sourceKind === "staged" && !hasStagedChanges()) {
          console.log(pc.yellow("No staged changes found. Nothing to review."));
          process.exit(0);
        }

        // 設定ロード
        const config = loadConfig({
          provider: opts.provider,
          apiKey: opts.apiKey,
          model: opts.model,
          rulesPath: opts.rules,
          verbose: opts.verbose ?? false,
          noBlock: opts.block === false, // commander の --no-block は opts.block=false を生成する
        });

        // ルールファイルの存在確認
        if (!existsSync(config.rulesPath)) {
          console.error(pc.red(`Rules file not found: ${config.rulesPath}`));
          console.error(pc.dim("Run 'kanzaki init' to create one."));
          process.exit(1);
        }

        // ルール解析
        const {
          rules,
          context: rulesContext,
          errors: parseErrors,
        } = parseRulesFile(config.rulesPath);

        if (parseErrors && parseErrors.length > 0) {
          console.error(
            pc.bold(
              pc.red(
                `\n❌ Found ${parseErrors.length} formatting error(s) in ${config.rulesPath}:`,
              ),
            ),
          );
          parseErrors.forEach((err) => {
            console.error(pc.yellow(`  Line ${err.line}: `) + err.message);
          });
          console.error(pc.dim("\nPlease fix these errors before committing."));
          process.exit(1);
        }

        if (rules.length === 0) {
          console.log(
            pc.yellow("No rules found in rules file. Skipping review."),
          );
          process.exit(0);
        }

        const errorRules = rules.filter((r) => r.severity === "error").length;
        const warnRules = rules.filter((r) => r.severity === "warn").length;

        if (config.verbose) {
          console.log(pc.dim(`Provider: ${config.provider} (${config.model})`));
          console.log(
            pc.dim(`Rules: ${errorRules} errors, ${warnRules} warnings`),
          );
          if (rulesContext) {
            console.log(
              pc.dim(
                `Context: ${rulesContext.length} chars of additional context`,
              ),
            );
          }
        }

        // 起点に応じてソース取得
        const source = getReviewSource({
          kind: sourceKind,
          range: opts.range,
          files: opts.files,
        });

        if (source.files.length === 0) {
          console.log(
            pc.yellow(`No files to review (source: ${source.label}).`),
          );
          process.exit(0);
        }

        // ファイルスコープでルールをフィルタリング
        const applicableRules = filterRulesByFiles(rules, source.files);

        if (applicableRules.length === 0) {
          console.log(
            pc.yellow(
              "No applicable rules for changed files. Skipping review.",
            ),
          );
          process.exit(0);
        }

        // @state(globs) で指定された追加ファイルを収集
        const extraPaths = collectExtraStatePaths(
          applicableRules,
          source.files,
        );
        const fileContexts = getFileContextsForSource(source, extraPaths);

        if (config.verbose) {
          console.log(pc.dim(`Source: ${source.label}`));
          console.log(pc.dim(`Files: ${source.files.join(", ")}`));
          if (extraPaths.length > 0) {
            console.log(pc.dim(`Extra state files: ${extraPaths.join(", ")}`));
          }
          if (applicableRules.length < rules.length) {
            console.log(
              pc.dim(
                `Rules filtered: ${applicableRules.length}/${rules.length} applicable`,
              ),
            );
          }
        }

        // LLMレビュー
        console.log(pc.dim("Reviewing changes with LLM..."));
        const result = await review(
          config,
          applicableRules,
          source,
          fileContexts,
          rulesContext,
        );

        // 結果表示
        const { errorCount } = report(result, config.verbose, config.noBlock);

        // エージェント向けフィードバックの書き出し（オプトイン）
        if (opts.emitFeedback) {
          const rulesDir = dirname(resolve(config.rulesPath));
          const reviewsDir = resolve(rulesDir, "reviews");
          const feedbackPath = writeFeedbackFile(
            result,
            applicableRules,
            source,
            reviewsDir,
          );
          if (feedbackPath) {
            console.log(pc.dim(`→ Feedback written to ${feedbackPath}`));
          }
        }

        // errorのみブロック（warnはブロックしない）
        if (errorCount > 0 && !config.noBlock) {
          process.exit(1);
        }
      } catch (error) {
        console.error(pc.red(`Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });

  // ── login ─────────────────────────────────────────────
  const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const;
  type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

  program
    .command("login")
    .description("Authenticate with a supported LLM provider")
    .option(
      "-p, --provider <provider>",
      `Provider to use (${SUPPORTED_PROVIDERS.join(" / ")})`,
    )
    .option(
      "--use-chatgpt",
      "Log in with ChatGPT Plus/Pro subscription (OAuth)",
    )
    .option("--use-claude", "Use the local Claude CLI as a subprocess")
    .action(async (opts) => {
      if (opts.useChatgpt) {
        // OpenAI OAuth Flow

        console.log(pc.dim("Starting OAuth Authorization Code Flow..."));
        try {
          const token = await loginWithOAuthPKCE();

          const expiresAt = new Date(
            Date.now() + token.expires_in * 1000,
          ).toISOString();
          saveCredentials({
            provider: "openai",
            apiKey: "",
            oauthToken: token.access_token,
            refreshToken: token.refresh_token,
            expiresAt,
          });

          console.log(pc.green("\n✓ Authenticated via OAuth"));
        } catch (error) {
          console.error(pc.red(`OAuth failed: ${(error as Error).message}`));
          console.error(pc.dim("Try 'kanzaki login' with an API key instead."));
          process.exit(1);
        }
      } else if (opts.useClaude) {
        // Claude CLI subprocess flow (OpenClaw style)
        console.log(pc.dim("Checking local Claude CLI installation..."));

        try {
          const version = execSync("claude --version", {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          console.log(pc.dim(`Found: ${version}`));
        } catch {
          console.error(pc.red("Claude CLI not found."));
          console.error(
            pc.dim(
              "Install it from https://docs.claude.com/en/docs/claude-code and run 'claude login' first.",
            ),
          );
          process.exit(1);
        }

        saveCredentials({
          provider: "anthropic",
          apiKey: "",
          useClaudeCli: true,
        });

        console.log(pc.green("\n✓ Configured to use local Claude CLI"));
        console.log(
          pc.dim(
            "Kanzaki will invoke 'claude -p' for reviews, using your existing Claude CLI session.",
          ),
        );
        console.log(
          pc.dim("Credentials stored in ~/.config/kanzaki/credentials.json"),
        );
      } else {
        // API Key入力（--provider 必須）
        if (!opts.provider) {
          console.error(pc.red("Authentication method is required."));
          console.error(pc.dim("Use one of:"));
          console.error(
            pc.dim(
              `  kanzaki login --provider <${SUPPORTED_PROVIDERS.join(" | ")}>   (API key)`,
            ),
          );
          console.error(
            pc.dim(
              "  kanzaki login --use-chatgpt                         (ChatGPT OAuth)",
            ),
          );
          console.error(
            pc.dim(
              "  kanzaki login --use-claude                          (Claude CLI subprocess)",
            ),
          );
          process.exit(1);
        }

        if (!SUPPORTED_PROVIDERS.includes(opts.provider as SupportedProvider)) {
          console.error(pc.red(`Unknown provider: ${opts.provider}`));
          console.error(
            pc.dim(`Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`),
          );
          process.exit(1);
        }

        const provider = opts.provider as SupportedProvider;
        const label = provider === "openai" ? "OpenAI" : "Anthropic";
        const key = await promptSecret(`Enter your ${label} API key: `);

        if (!key) {
          console.error(pc.red("No API key provided."));
          process.exit(1);
        }

        saveCredentials({ provider, apiKey: key });
        console.log(pc.green(`✓ Saved ${provider} credentials`));
        console.log(
          pc.dim("Credentials stored in ~/.config/kanzaki/credentials.json"),
        );
      }
    });

  // ── logout ────────────────────────────────────────────
  program
    .command("logout")
    .description("Remove saved credentials")
    .action(() => {
      clearCredentials();
      console.log(pc.green("✓ Credentials removed"));
    });

  // ── status ────────────────────────────────────────────
  program
    .command("status")
    .description("Show authentication status")
    .action(() => {
      const creds = loadCredentials();
      if (
        !creds ||
        (!creds.apiKey && !creds.oauthToken && !creds.useClaudeCli)
      ) {
        console.log(pc.yellow("Not authenticated."));
        console.log(pc.dim("Run 'kanzaki login' to authenticate."));
        return;
      }

      console.log(pc.bold("Kanzaki Status"));
      console.log(`  Provider: ${pc.cyan(creds.provider)}`);

      if (creds.useClaudeCli) {
        console.log(
          `  Auth: ${pc.cyan("Claude CLI subprocess")} ${pc.green("(active)")}`,
        );
      } else if (creds.oauthToken) {
        const expired =
          creds.expiresAt && new Date(creds.expiresAt) < new Date();
        console.log(
          `  Auth: ${pc.cyan("OAuth")}${expired ? pc.red(" (expired)") : pc.green(" (active)")}`,
        );
      } else {
        const masked =
          creds.apiKey.slice(0, 7) + "..." + creds.apiKey.slice(-4);
        console.log(`  Auth: ${pc.cyan("API Key")} (${masked})`);
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

/**
 * @state(globs) に指定されたglobにマッチするファイルを、
 * git ls-files から取得して返す（既に対象になっているファイルは除外）。
 */
function collectExtraStatePaths(
  rules: Rule[],
  alreadyIncluded: string[],
): string[] {
  const patterns = Array.from(
    new Set(rules.flatMap((r) => r.stateExtraPatterns)),
  );
  if (patterns.length === 0) return [];

  const trackedFiles = listTrackedFiles();
  if (trackedFiles.length === 0) return [];

  const included = new Set(alreadyIncluded);
  const matched = new Set<string>();
  for (const file of trackedFiles) {
    if (included.has(file)) continue;
    if (patterns.some((p) => matchGlob(file, p))) {
      matched.add(file);
    }
  }
  return Array.from(matched);
}
