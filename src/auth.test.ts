import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// auth.ts は import 時に homedir() を呼んで CONFIG_DIR を確定する。
// 実ユーザーの ~/.config/kanzaki を踏まないよう、import 前に node:os.homedir を差し替える。
const { fakeHome } = vi.hoisted(() => {
  // vi.hoisted 内では require で同期的に準備する必要がある（ESM import は使えない）
  const { mkdtempSync: mkd } = require("node:fs") as typeof import("node:fs");
  const { tmpdir: tdir } = require("node:os") as typeof import("node:os");
  const { join: pjoin } = require("node:path") as typeof import("node:path");
  return { fakeHome: mkd(pjoin(tdir(), "kanzaki-auth-home-")) };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

const { clearCredentials, getActiveApiKey, loadCredentials, saveCredentials } =
  await import("./auth.js");

const credentialsPath = resolve(
  fakeHome,
  ".config",
  "kanzaki",
  "credentials.json",
);

afterEach(() => {
  if (existsSync(credentialsPath)) rmSync(credentialsPath, { force: true });
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("getActiveApiKey", () => {
  it("returns 'claude-cli' dummy when useClaudeCli flag is set", () => {
    expect(
      getActiveApiKey({
        provider: "anthropic",
        apiKey: "real-key",
        useClaudeCli: true,
      }),
    ).toBe("claude-cli");
  });

  it("returns oauthToken when present and expiresAt is absent", () => {
    expect(
      getActiveApiKey({
        provider: "openai",
        apiKey: "fallback",
        oauthToken: "oauth",
      }),
    ).toBe("oauth");
  });

  it("returns oauthToken when it hasn't expired", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(
      getActiveApiKey({
        provider: "openai",
        apiKey: "fallback",
        oauthToken: "oauth",
        expiresAt: future,
      }),
    ).toBe("oauth");
  });

  it("falls back to apiKey when oauthToken is expired", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(
      getActiveApiKey({
        provider: "openai",
        apiKey: "fallback",
        oauthToken: "oauth",
        expiresAt: past,
      }),
    ).toBe("fallback");
  });

  it("returns apiKey when no oauthToken and no useClaudeCli", () => {
    expect(getActiveApiKey({ provider: "openai", apiKey: "plain-key" })).toBe(
      "plain-key",
    );
  });
});

describe("loadCredentials", () => {
  it("returns null when the credentials file doesn't exist", () => {
    expect(loadCredentials()).toBeNull();
  });

  it("returns parsed credentials when the file contains valid JSON", () => {
    saveCredentials({ provider: "openai", apiKey: "k-123" });
    const got = loadCredentials();
    expect(got).toEqual({ provider: "openai", apiKey: "k-123" });
  });

  it("returns null when the file contains invalid JSON", () => {
    saveCredentials({ provider: "openai", apiKey: "seed" });
    writeFileSync(credentialsPath, "{not json", "utf-8");
    expect(loadCredentials()).toBeNull();
  });
});

describe("saveCredentials", () => {
  it("creates the config dir if it doesn't exist and writes the JSON", () => {
    expect(existsSync(credentialsPath)).toBe(false);
    saveCredentials({
      provider: "anthropic",
      apiKey: "anthropic-key",
      oauthToken: "tok",
      expiresAt: "2100-01-01T00:00:00.000Z",
    });
    expect(existsSync(credentialsPath)).toBe(true);
    const raw = readFileSync(credentialsPath, "utf-8");
    expect(JSON.parse(raw)).toMatchObject({
      provider: "anthropic",
      apiKey: "anthropic-key",
      oauthToken: "tok",
    });
  });

  it("overwrites an existing credentials file", () => {
    saveCredentials({ provider: "openai", apiKey: "first" });
    saveCredentials({ provider: "openai", apiKey: "second" });
    expect(loadCredentials()).toEqual({
      provider: "openai",
      apiKey: "second",
    });
  });
});

describe("clearCredentials", () => {
  it("is a no-op when no credentials file exists", () => {
    expect(() => clearCredentials()).not.toThrow();
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it("removes the credentials file when it exists", () => {
    saveCredentials({ provider: "openai", apiKey: "k" });
    expect(existsSync(credentialsPath)).toBe(true);
    clearCredentials();
    expect(existsSync(credentialsPath)).toBe(false);
  });
});

describe("home dir isolation", () => {
  it("writes under the mocked homedir, not the real ~", () => {
    saveCredentials({ provider: "openai", apiKey: "k" });
    // fakeHome 配下に credentials が作られていることをパスレベルで検証
    expect(credentialsPath.startsWith(fakeHome)).toBe(true);
    expect(existsSync(join(fakeHome, ".config", "kanzaki"))).toBe(true);
  });
});
