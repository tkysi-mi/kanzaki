import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface StagedChanges {
  /** git diff --staged の出力 */
  diff: string;
  /** 変更されたファイルのパス一覧 */
  files: string[];
}

export interface FileContext {
  /** ファイルパス（リポジトリルートからの相対パス） */
  path: string;
  /** ファイルの全文内容 */
  content: string;
}

/**
 * ステージされた変更のdiffとファイル一覧を取得する。
 */
export function getStagedChanges(): StagedChanges {
  const diff = exec("git diff --staged");
  const filesRaw = exec("git diff --staged --name-only");
  const files = filesRaw
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  return { diff, files };
}

/**
 * 変更されたファイルの全文内容を取得する（LLMへのコンテキスト用）。
 * バイナリファイルはスキップする。
 */
export function getFileContexts(files: string[]): FileContext[] {
  const repoRoot = getRepoRoot();
  const contexts: FileContext[] = [];

  for (const file of files) {
    const absPath = resolve(repoRoot, file);
    if (!existsSync(absPath)) continue;

    // バイナリファイルの簡易判定
    if (isBinaryPath(file)) continue;

    try {
      const content = readFileSync(absPath, "utf-8");
      // 極端に大きいファイルはスキップ (100KB超)
      if (content.length > 100_000) continue;
      contexts.push({ path: file, content });
    } catch {
      // 読み取れないファイルはスキップ
    }
  }

  return contexts;
}

/**
 * Gitリポジトリのルートディレクトリを取得する。
 */
export function getRepoRoot(): string {
  return exec("git rev-parse --show-toplevel").trim();
}

/**
 * ステージされた変更があるかチェック。
 */
export function hasStagedChanges(): boolean {
  const output = exec("git diff --staged --name-only");
  return output.trim().length > 0;
}

function exec(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`Git command failed: ${command}\n${err.stderr ?? err.message}`);
  }
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".mp4", ".webm", ".mov", ".avi",
  ".mp3", ".wav", ".ogg",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".exe", ".dll", ".so", ".dylib",
  ".lock",
]);

function isBinaryPath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}
