import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFileContextsForSource,
  getReviewSource,
  hasStagedChanges,
  listTrackedFiles,
} from "./git.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanzaki-git-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

describe("git module", () => {
  let repo: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    repo = initRepo();
    process.chdir(repo);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  describe("hasStagedChanges", () => {
    it("returns false on a fresh repo", () => {
      expect(hasStagedChanges()).toBe(false);
    });

    it("returns true after staging a new file", () => {
      writeFileSync(join(repo, "a.txt"), "hello\n");
      git(repo, ["add", "a.txt"]);
      expect(hasStagedChanges()).toBe(true);
    });

    it("returns false again after committing", () => {
      writeFileSync(join(repo, "a.txt"), "hello\n");
      git(repo, ["add", "a.txt"]);
      git(repo, ["commit", "-q", "-m", "init"]);
      expect(hasStagedChanges()).toBe(false);
    });
  });

  describe("listTrackedFiles", () => {
    it("returns [] on an empty repo", () => {
      expect(listTrackedFiles()).toEqual([]);
    });

    it("returns committed files", () => {
      writeFileSync(join(repo, "a.txt"), "a\n");
      writeFileSync(join(repo, "b.md"), "b\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", "init"]);
      const files = listTrackedFiles().sort();
      expect(files).toEqual(["a.txt", "b.md"]);
    });
  });

  describe("getReviewSource: staged", () => {
    it("captures staged diff and file list", () => {
      writeFileSync(join(repo, "a.txt"), "hello\n");
      git(repo, ["add", "a.txt"]);
      const src = getReviewSource({ kind: "staged" });
      expect(src.kind).toBe("staged");
      expect(src.label).toBe("staged");
      expect(src.files).toEqual(["a.txt"]);
      expect(src.diff).toContain("hello");
    });
  });

  describe("getReviewSource: workingTree", () => {
    it("captures unstaged edits against HEAD", () => {
      writeFileSync(join(repo, "a.txt"), "v1\n");
      git(repo, ["add", "a.txt"]);
      git(repo, ["commit", "-q", "-m", "init"]);
      writeFileSync(join(repo, "a.txt"), "v2\n");
      const src = getReviewSource({ kind: "workingTree" });
      expect(src.kind).toBe("workingTree");
      expect(src.label).toBe("working tree (vs HEAD)");
      expect(src.files).toEqual(["a.txt"]);
      expect(src.diff).toContain("v2");
    });
  });

  describe("getReviewSource: range", () => {
    it("captures diff between two revisions", () => {
      writeFileSync(join(repo, "a.txt"), "v1\n");
      git(repo, ["add", "a.txt"]);
      git(repo, ["commit", "-q", "-m", "c1"]);
      writeFileSync(join(repo, "a.txt"), "v2\n");
      git(repo, ["add", "a.txt"]);
      git(repo, ["commit", "-q", "-m", "c2"]);
      const src = getReviewSource({ kind: "range", range: "HEAD~1..HEAD" });
      expect(src.kind).toBe("range");
      expect(src.label).toBe("range:HEAD~1..HEAD");
      expect(src.files).toEqual(["a.txt"]);
      expect(src.diff).toMatch(/-v1/);
      expect(src.diff).toMatch(/\+v2/);
    });

    it("throws when range option missing", () => {
      expect(() => getReviewSource({ kind: "range" })).toThrow(/range option/);
    });
  });

  describe("getReviewSource: files", () => {
    it("accepts relative paths and produces empty diff", () => {
      writeFileSync(join(repo, "a.txt"), "hello\n");
      const src = getReviewSource({ kind: "files", files: ["a.txt"] });
      expect(src.kind).toBe("files");
      expect(src.label).toBe("files");
      expect(src.diff).toBe("");
      expect(src.files).toEqual(["a.txt"]);
    });

    it("normalizes absolute paths under the repo root to POSIX-relative", () => {
      writeFileSync(join(repo, "a.txt"), "hello\n");
      const abs = resolve(repo, "a.txt");
      const src = getReviewSource({ kind: "files", files: [abs] });
      expect(src.files).toEqual(["a.txt"]);
    });

    it("throws when files option is empty", () => {
      expect(() => getReviewSource({ kind: "files", files: [] })).toThrow(
        /at least one path/,
      );
    });
  });

  describe("getFileContextsForSource", () => {
    it("reads file content for staged source", () => {
      writeFileSync(join(repo, "a.txt"), "hello\n");
      git(repo, ["add", "a.txt"]);
      const src = getReviewSource({ kind: "staged" });
      const ctxs = getFileContextsForSource(src);
      expect(ctxs).toEqual([{ path: "a.txt", content: "hello\n" }]);
    });

    it("merges extraPaths and dedupes", () => {
      writeFileSync(join(repo, "a.txt"), "a\n");
      writeFileSync(join(repo, "b.md"), "b\n");
      const src = getReviewSource({ kind: "files", files: ["a.txt"] });
      const ctxs = getFileContextsForSource(src, ["a.txt", "b.md"]);
      expect(ctxs.map((c) => c.path).sort()).toEqual(["a.txt", "b.md"]);
    });

    it("skips binary extensions", () => {
      writeFileSync(join(repo, "logo.png"), "\x89PNG\r\n");
      const src = getReviewSource({ kind: "files", files: ["logo.png"] });
      expect(getFileContextsForSource(src)).toEqual([]);
    });

    it("skips files > 100KB", () => {
      writeFileSync(join(repo, "big.txt"), "x".repeat(100_001));
      const src = getReviewSource({ kind: "files", files: ["big.txt"] });
      expect(getFileContextsForSource(src)).toEqual([]);
    });

    it("skips non-existent paths without throwing", () => {
      const src = getReviewSource({ kind: "files", files: ["missing.txt"] });
      expect(getFileContextsForSource(src)).toEqual([]);
    });

    it("reads committed content via git show for range kind", () => {
      writeFileSync(join(repo, "a.txt"), "v1\n");
      git(repo, ["add", "a.txt"]);
      git(repo, ["commit", "-q", "-m", "c1"]);
      writeFileSync(join(repo, "a.txt"), "v2\n");
      git(repo, ["add", "a.txt"]);
      git(repo, ["commit", "-q", "-m", "c2"]);
      const src = getReviewSource({ kind: "range", range: "HEAD~1..HEAD" });
      const ctxs = getFileContextsForSource(src);
      // range reads the END ref (HEAD) content
      expect(ctxs).toEqual([{ path: "a.txt", content: "v2\n" }]);
    });
  });
});
