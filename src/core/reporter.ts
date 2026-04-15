import chalk from "chalk";
import type { ReviewResult } from "../llm/types.js";

export interface ReportSummary {
  /** エラー（ブロック対象）の失敗数 */
  errorCount: number;
  /** 警告の失敗数 */
  warnCount: number;
}

/**
 * レビュー結果をターミナルに出力する。
 * @returns エラーと警告の失敗数
 */
export function report(result: ReviewResult, verbose: boolean): ReportSummary {
  const { results, summary } = result;

  console.log();
  console.log(chalk.bold.underline("Kanzaki Review Results"));
  console.log();

  let errorCount = 0;
  let warnCount = 0;

  for (const r of results) {
    const isWarn = r.severity === "warn";
    const label = isWarn ? chalk.dim("[warn]") : chalk.dim("[error]");

    if (r.passed) {
      console.log(`  ${chalk.green("✓")} ${label} ${r.rule}`);
      if (verbose) {
        console.log(`    ${chalk.dim(r.reason)}`);
      }
    } else {
      if (isWarn) {
        warnCount++;
        console.log(`  ${chalk.yellow("⚠")} ${label} ${r.rule}`);
        console.log(`    ${chalk.yellow("→")} ${r.reason}`);
      } else {
        errorCount++;
        console.log(`  ${chalk.red("✗")} ${label} ${r.rule}`);
        console.log(`    ${chalk.red("→")} ${r.reason}`);
      }
    }
  }

  // サマリー
  console.log();
  const total = results.length;
  const passedCount = total - errorCount - warnCount;

  if (errorCount === 0 && warnCount === 0) {
    console.log(chalk.green.bold(`  All ${total} rules passed ✓`));
  } else {
    const parts: string[] = [];
    parts.push(`${passedCount}/${total} passed`);
    if (errorCount > 0) parts.push(chalk.red(`${errorCount} errors`));
    if (warnCount > 0) parts.push(chalk.yellow(`${warnCount} warnings`));
    console.log(`  ${parts.join(", ")}`);

    if (errorCount > 0) {
      console.log(chalk.red.bold("\n  Commit blocked due to errors."));
    } else {
      console.log(chalk.yellow("\n  Warnings found, but commit allowed."));
    }
  }

  if (summary) {
    console.log();
    console.log(chalk.dim(`  ${summary}`));
  }

  console.log();

  return { errorCount, warnCount };
}
