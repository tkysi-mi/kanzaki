import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute, relative } from "node:path";

/**
 * レビューの起点種別。
 * - staged: `git diff --staged`（デフォルト、pre-commit用途）
 * - workingTree: `git diff HEAD`（staged + unstaged）
 * - range: `git diff <a..b>`（任意のリビジョン間、CI/PRレビュー用途）
 * - files: 指定ファイルの現状を読むのみ（diffなし、git管理外もOK）
 */
export type ReviewSourceKind = "staged" | "workingTree" | "range" | "files";

export interface ReviewSourceOptions {
  kind: ReviewSourceKind;
  /** range: "main..HEAD" のようなリビジョン指定 */
  range?: string;
  /** files: レビュー対象のファイルパス */
  files?: string[];
}

export interface ReviewSource {
  kind: ReviewSourceKind;
  /** 人間向けの起点ラベル（例: "staged", "working tree", "range:main..HEAD", "files"） */
  label: string;
  /** 差分本文。files モードでは空文字 */
  diff: string;
  /** 対象ファイル一覧（リポジトリルートからの相対パス、または絶対パス） */
  files: string[];
}

export interface FileContext {
  /** ファイルパス（表示用） */
  path: string;
  /** ファイルの全文内容 */
  content: string;
}

/**
 * 起点の種別に応じてdiffとファイル一覧を取得する。
 */
export function getReviewSource(opts: ReviewSourceOptions): ReviewSource {
  switch (opts.kind) {
    case "staged":
      return getStagedSource();
    case "workingTree":
      return getWorkingTreeSource();
    case "range":
      if (!opts.range) throw new Error("range option is required for range source");
      return getRangeSource(opts.range);
    case "files":
      if (!opts.files || opts.files.length === 0) {
        throw new Error("files option requires at least one path");
      }
      return getFilesSource(opts.files);
  }
}

/**
 * 指定起点に対応するファイルコンテキストを取得する。
 * range の場合は終端リビジョンでの内容、それ以外は作業ツリー（filesystem）の内容を読む。
 */
export function getFileContextsForSource(
  source: ReviewSource,
  extraPaths: string[] = [],
): FileContext[] {
  if (source.kind === "range") {
    const endRef = extractEndRef(extractRangeFromLabel(source.label));
    const paths = dedupe([...source.files, ...extraPaths]);
    const contexts: FileContext[] = [];
    for (const p of paths) {
      if (isBinaryPath(p)) continue;
      const content = readFileAtRef(endRef, p);
      if (content === null) continue;
      if (content.length > 100_000) continue;
      contexts.push({ path: p, content });
    }
    return contexts;
  }

  const contexts: FileContext[] = [];
  const seen = new Set<string>();
  const repoRoot = safeRepoRoot();

  const collect = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);

    if (isBinaryPath(path)) return;

    const absPath = isAbsolute(path)
      ? path
      : repoRoot
        ? resolve(repoRoot, path)
        : resolve(process.cwd(), path);

    if (!existsSync(absPath)) return;
    try {
      const content = readFileSync(absPath, "utf-8");
      if (content.length > 100_000) return;
      contexts.push({ path, content });
    } catch {
      // 読み取れないファイルはスキップ
    }
  };

  for (const f of source.files) collect(f);
  for (const f of extraPaths) collect(f);
  return contexts;
}

function getStagedSource(): ReviewSource {
  const diff = execGit(["diff", "--staged"]);
  const files = splitFiles(execGit(["diff", "--staged", "--name-only"]));
  return { kind: "staged", label: "staged", diff, files };
}

function getWorkingTreeSource(): ReviewSource {
  const diff = execGit(["diff", "HEAD"]);
  const files = splitFiles(execGit(["diff", "HEAD", "--name-only"]));
  return { kind: "workingTree", label: "working tree (vs HEAD)", diff, files };
}

function getRangeSource(range: string): ReviewSource {
  const diff = execGit(["diff", range]);
  const files = splitFiles(execGit(["diff", range, "--name-only"]));
  return { kind: "range", label: `range:${range}`, diff, files };
}

function getFilesSource(paths: string[]): ReviewSource {
  const repoRoot = safeRepoRoot();
  const normalized = paths.map((p) => {
    if (!isAbsolute(p)) return p;
    if (repoRoot) {
      const rel = relative(repoRoot, p);
      if (!rel.startsWith("..")) return rel.split("\\").join("/");
    }
    return p;
  });
  return { kind: "files", label: "files", diff: "", files: normalized };
}

/**
 * ステージされた変更があるかチェック。
 */
export function hasStagedChanges(): boolean {
  try {
    const output = execGit(["diff", "--staged", "--name-only"]);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Gitリポジトリのルートディレクトリを取得する。
 */
export function getRepoRoot(): string {
  return execGit(["rev-parse", "--show-toplevel"]).trim();
}

function safeRepoRoot(): string | null {
  try {
    return getRepoRoot();
  } catch {
    return null;
  }
}

function execGit(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`Git command failed: git ${args.join(" ")}\n${err.stderr ?? err.message}`);
  }
}

function readFileAtRef(ref: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function splitFiles(raw: string): string[] {
  return raw
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function extractRangeFromLabel(label: string): string {
  return label.startsWith("range:") ? label.slice("range:".length) : label;
}

/**
 * "a..b" や "a...b" から終端リビジョンを取り出す。単一refの場合はそのまま返す。
 */
function extractEndRef(range: string): string {
  const tripleIdx = range.indexOf("...");
  if (tripleIdx >= 0) {
    const end = range.slice(tripleIdx + 3).trim();
    return end.length > 0 ? end : "HEAD";
  }
  const doubleIdx = range.indexOf("..");
  if (doubleIdx >= 0) {
    const end = range.slice(doubleIdx + 2).trim();
    return end.length > 0 ? end : "HEAD";
  }
  return range;
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
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

// ── 後方互換API ─────────────────────────────────────────

export interface StagedChanges {
  diff: string;
  files: string[];
}

/** @deprecated use getReviewSource({kind:"staged"}) instead */
export function getStagedChanges(): StagedChanges {
  const s = getStagedSource();
  return { diff: s.diff, files: s.files };
}

/** @deprecated use getFileContextsForSource instead */
export function getFileContexts(files: string[]): FileContext[] {
  const repoRoot = safeRepoRoot();
  const contexts: FileContext[] = [];
  for (const file of files) {
    if (isBinaryPath(file)) continue;
    const absPath = repoRoot ? resolve(repoRoot, file) : resolve(process.cwd(), file);
    if (!existsSync(absPath)) continue;
    try {
      const content = readFileSync(absPath, "utf-8");
      if (content.length > 100_000) continue;
      contexts.push({ path: file, content });
    } catch {
      // skip
    }
  }
  return contexts;
}
