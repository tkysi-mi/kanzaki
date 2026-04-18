import pc from "picocolors";
import type { ReviewResult } from "../llm/types.js";

export interface ReportSummary {
  /** エラー（ブロック対象）の失敗数 */
  errorCount: number;
  /** 警告の失敗数 */
  warnCount: number;
}

/**
 * レビュー結果をターミナルに出力する。
 * @param noBlock --no-block 指定時は true。エラーがあっても「blocked」表示にしない。
 * @returns エラーと警告の失敗数
 */
export function report(
  result: ReviewResult,
  verbose: boolean,
  noBlock = false,
): ReportSummary {
  const { results, summary } = result;

  console.log();
  console.log(pc.bold(pc.underline("Kanzaki Review Results")));
  console.log();

  let errorCount = 0;
  let warnCount = 0;

  for (const r of results) {
    const isWarn = r.severity === "warn";
    const label = isWarn ? pc.dim("[warn]") : pc.dim("[error]");

    if (r.passed) {
      console.log(`  ${pc.green("✓")} ${label} ${r.rule}`);
      if (verbose) {
        console.log(`    ${pc.dim(r.reason)}`);
      }
    } else {
      if (isWarn) {
        warnCount++;
        console.log(`  ${pc.yellow("⚠")} ${label} ${r.rule}`);
        console.log(`    ${pc.yellow("→")} ${r.reason}`);
      } else {
        errorCount++;
        console.log(`  ${pc.red("✗")} ${label} ${r.rule}`);
        console.log(`    ${pc.red("→")} ${r.reason}`);
      }
    }
  }

  // サマリー
  console.log();
  const total = results.length;
  const passedCount = total - errorCount - warnCount;

  if (errorCount === 0 && warnCount === 0) {
    console.log(pc.bold(pc.green(`  All ${total} rules passed ✓`)));
  } else {
    const parts: string[] = [];
    parts.push(`${passedCount}/${total} passed`);
    if (errorCount > 0) parts.push(pc.red(`${errorCount} errors`));
    if (warnCount > 0) parts.push(pc.yellow(`${warnCount} warnings`));
    console.log(`  ${parts.join(", ")}`);

    if (errorCount > 0) {
      if (noBlock) {
        console.log(
          pc.yellow("\n  Errors found, but commit allowed (--no-block)."),
        );
      } else {
        console.log(pc.bold(pc.red("\n  Commit blocked due to errors.")));
      }
    } else {
      console.log(pc.yellow("\n  Warnings found, but commit allowed."));
    }
  }

  if (summary) {
    console.log();
    console.log(pc.dim(`  ${summary}`));
  }

  console.log();

  return { errorCount, warnCount };
}
