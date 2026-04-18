import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredCredentials } from "./auth.js";

// auth.js をモックして、ファイルシステム上の ~/.config/kanzaki/credentials.json
// への依存を切り離す。
vi.mock("./auth.js", () => {
  let stored: StoredCredentials | null = null;
  return {
    loadCredentials: vi.fn(() => stored),
    getActiveApiKey: vi.fn((c: StoredCredentials) => {
      if (c.useClaudeCli) return "claude-cli";
      // 本物の getActiveApiKey と同じく、OAuth が期限切れなら apiKey にフォールバック
      if (c.oauthToken) {
        if (!c.expiresAt) return c.oauthToken;
        if (new Date(c.expiresAt) > new Date()) return c.oauthToken;
      }
      return c.apiKey;
    }),
    __setStored: (c: StoredCredentials | null) => {
      stored = c;
    },
  };
});

const authModule = (await import("./auth.js")) as unknown as {
  __setStored: (c: StoredCredentials | null) => void;
};
const { loadConfig } = await import("./config.js");

const ENV_KEYS = [
  "KANZAKI_API_KEY",
  "KANZAKI_PROVIDER",
  "KANZAKI_MODEL",
  "KANZAKI_RULES_PATH",
];

let tmpCwd: string;
let prevCwd: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  prevCwd = process.cwd();
  tmpCwd = mkdtempSync(join(tmpdir(), "kanzaki-config-test-"));
  process.chdir(tmpCwd);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  authModule.__setStored(null);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpCwd, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("loadConfig", () => {
  it("throws when no API key is available anywhere", () => {
    expect(() => loadConfig()).toThrow(/API key is required/);
  });

  it("uses KANZAKI_API_KEY env var when no override or stored creds", () => {
    process.env.KANZAKI_API_KEY = "env-key";
    const cfg = loadConfig();
    expect(cfg.apiKey).toBe("env-key");
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5.4");
  });

  it("overrides take priority over env and stored creds", () => {
    process.env.KANZAKI_API_KEY = "env-key";
    authModule.__setStored({ provider: "anthropic", apiKey: "stored-key" });
    const cfg = loadConfig({ apiKey: "override-key", provider: "anthropic" });
    expect(cfg.apiKey).toBe("override-key");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
  });

  it("falls back to stored credentials' active API key when env is unset", () => {
    authModule.__setStored({
      provider: "anthropic",
      apiKey: "stored-anthropic",
    });
    const cfg = loadConfig();
    expect(cfg.apiKey).toBe("stored-anthropic");
    expect(cfg.provider).toBe("anthropic");
  });

  it("sets useOAuth=true when stored creds have an oauthToken", () => {
    authModule.__setStored({
      provider: "openai",
      apiKey: "fallback",
      oauthToken: "oauth-tok",
    });
    const cfg = loadConfig();
    expect(cfg.useOAuth).toBe(true);
    expect(cfg.apiKey).toBe("oauth-tok");
  });

  it("throws a ChatGPT-specific error when the OAuth session has expired", () => {
    authModule.__setStored({
      provider: "openai",
      apiKey: "",
      oauthToken: "oauth-tok",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(() => loadConfig()).toThrow(/ChatGPT OAuth session has expired/);
    expect(() => loadConfig()).toThrow(/--use-chatgpt/);
  });

  it("sets useClaudeCli=true when stored creds request it", () => {
    authModule.__setStored({
      provider: "anthropic",
      apiKey: "unused",
      useClaudeCli: true,
    });
    const cfg = loadConfig();
    expect(cfg.useClaudeCli).toBe(true);
    expect(cfg.apiKey).toBe("claude-cli");
  });

  it("resolves KANZAKI_RULES_PATH to an absolute path under cwd", () => {
    process.env.KANZAKI_API_KEY = "k";
    process.env.KANZAKI_RULES_PATH = "custom/rules.md";
    const cfg = loadConfig();
    expect(cfg.rulesPath).toBe(resolve(tmpCwd, "custom/rules.md"));
  });

  it("defaults rulesPath to .kanzaki/rules.md when unset", () => {
    process.env.KANZAKI_API_KEY = "k";
    const cfg = loadConfig();
    expect(cfg.rulesPath).toBe(resolve(tmpCwd, ".kanzaki/rules.md"));
  });

  it("respects KANZAKI_MODEL env override", () => {
    process.env.KANZAKI_API_KEY = "k";
    process.env.KANZAKI_MODEL = "custom-model";
    const cfg = loadConfig();
    expect(cfg.model).toBe("custom-model");
  });

  it("passes through verbose and noBlock overrides with false defaults", () => {
    process.env.KANZAKI_API_KEY = "k";
    expect(loadConfig()).toMatchObject({ verbose: false, noBlock: false });
    expect(loadConfig({ verbose: true, noBlock: true })).toMatchObject({
      verbose: true,
      noBlock: true,
    });
  });
});
