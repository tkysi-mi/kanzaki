import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// dist/bin.js への絶対パス（リポジトリルートからの相対で解決）
const BIN_PATH = resolve(
  fileURLToPath(new URL("../../dist/bin.js", import.meta.url)),
);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });
}

function setupRepo(
  rulesContent: string,
  stagedFile?: { path: string; content: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), "kanzaki-e2e-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "e2e@example.com"]);
  git(dir, ["config", "user.name", "e2e"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  mkdirSync(join(dir, ".kanzaki"), { recursive: true });
  writeFileSync(join(dir, ".kanzaki", "rules.md"), rulesContent, "utf-8");

  if (stagedFile) {
    const full = join(dir, stagedFile.path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, stagedFile.content, "utf-8");
    git(dir, ["add", stagedFile.path]);
  }
  return dir;
}

interface MockResponse {
  results: Array<{ rule: string; passed: boolean; reason: string }>;
  summary: string;
}

async function runCheck(
  cwd: string,
  mock: MockResponse,
  extraArgs: string[] = [],
) {
  return execa("node", [BIN_PATH, "check", ...extraArgs], {
    cwd,
    reject: false, // 非ゼロ exit を例外化しない
    env: {
      ...process.env,
      KANZAKI_API_KEY: "e2e-dummy",
      KANZAKI_MOCK_RESPONSE: JSON.stringify(mock),
    },
  });
}

const PASSING_RULES = "## Quality\n- [ ] Keep things tidy\n";
const FAILING_RULES = "## Quality\n- [ ] Must have tests\n";

let repo: string;

beforeEach(() => {
  repo = "";
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("kanzaki check (e2e)", () => {
  it("exits 0 when the mocked review passes", async () => {
    repo = setupRepo(PASSING_RULES, {
      path: "src/a.ts",
      content: "export {};\n",
    });
    const res = await runCheck(repo, {
      results: [{ rule: "Keep things tidy", passed: true, reason: "ok" }],
      summary: "all good",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("All 1 rules passed");
  });

  it("exits 1 when the mocked review has errors", async () => {
    repo = setupRepo(FAILING_RULES, {
      path: "src/a.ts",
      content: "export {};\n",
    });
    const res = await runCheck(repo, {
      results: [
        { rule: "Must have tests", passed: false, reason: "no tests added" },
      ],
      summary: "missing tests",
    });
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain("Review failed");
    expect(res.stdout).toContain("no tests added");
  });

  it("--no-block downgrades exit code to 0 even with errors", async () => {
    repo = setupRepo(FAILING_RULES, {
      path: "src/a.ts",
      content: "export {};\n",
    });
    const res = await runCheck(
      repo,
      {
        results: [{ rule: "Must have tests", passed: false, reason: "nope" }],
        summary: "",
      },
      ["--no-block"],
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("not blocked (--no-block)");
  });

  it("writes a feedback markdown to .kanzaki/reviews/ by default on failure", async () => {
    repo = setupRepo(FAILING_RULES, {
      path: "src/a.ts",
      content: "export {};\n",
    });
    await runCheck(repo, {
      results: [{ rule: "Must have tests", passed: false, reason: "fail" }],
      summary: "",
    });
    const reviewsDir = join(repo, ".kanzaki", "reviews");
    expect(existsSync(reviewsDir)).toBe(true);
    const files = readdirSync(reviewsDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.md$/);
  });

  it("--no-emit-feedback suppresses the markdown output", async () => {
    repo = setupRepo(FAILING_RULES, {
      path: "src/a.ts",
      content: "export {};\n",
    });
    await runCheck(
      repo,
      {
        results: [{ rule: "Must have tests", passed: false, reason: "fail" }],
        summary: "",
      },
      ["--no-emit-feedback"],
    );
    const reviewsDir = join(repo, ".kanzaki", "reviews");
    expect(existsSync(reviewsDir)).toBe(false);
  });
});
