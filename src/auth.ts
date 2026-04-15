import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = resolve(homedir(), ".config", "kanzaki");
const CREDENTIALS_PATH = resolve(CONFIG_DIR, "credentials.json");

export interface StoredCredentials {
  provider: "openai" | "anthropic";
  apiKey: string;
  /** OAuth token (if authenticated via OAuth) */
  oauthToken?: string;
  /** OAuth refresh token */
  refreshToken?: string;
  /** Token expiry (ISO string) */
  expiresAt?: string;
}

/**
 * 保存済み認証情報を読み込む。存在しない場合は null を返す。
 */
export function loadCredentials(): StoredCredentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;

  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

/**
 * 認証情報を ~/.config/kanzaki/credentials.json に保存する。
 */
export function saveCredentials(credentials: StoredCredentials): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), "utf-8");
}

/**
 * 保存済み認証情報を削除する。
 */
export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_PATH)) {
    writeFileSync(CREDENTIALS_PATH, "{}", "utf-8");
  }
}

/**
 * 認証情報が保存されているか確認する。
 */
export function hasCredentials(): boolean {
  const creds = loadCredentials();
  return creds !== null && (!!creds.apiKey || !!creds.oauthToken);
}

/**
 * 有効なAPIキーを取得する。
 * OAuth tokenがある場合はそちらを優先（有効期限チェック付き）。
 */
export function getActiveApiKey(creds: StoredCredentials): string {
  // OAuthトークンが有効ならそれを使う
  if (creds.oauthToken && creds.expiresAt) {
    const expiry = new Date(creds.expiresAt);
    if (expiry > new Date()) {
      return creds.oauthToken;
    }
  }

  // フォールバック: 通常のAPIキー
  return creds.apiKey;
}

// ── OAuth Device Flow ───────────────────────────────────

const OPENAI_DEVICE_AUTH_URL = "https://auth.openai.com/oauth/device/code";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "kanzaki-cli";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

/**
 * OAuth Device Code Flowを開始する。
 * ユーザーにuser_codeとURLを表示し、認可を待つ。
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(OPENAI_DEVICE_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OPENAI_CLIENT_ID,
      scope: "openai.public",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to request device code: ${res.status} ${body}`);
  }

  return (await res.json()) as DeviceCodeResponse;
}

/**
 * デバイスコードを使ってトークンをポーリングする。
 * ユーザーが認可するまで interval 秒ごとにリトライする。
 */
export async function pollForToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<TokenResponse> {
  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    const res = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: OPENAI_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (res.ok) {
      return (await res.json()) as TokenResponse;
    }

    const body = (await res.json()) as { error?: string };
    if (body.error === "authorization_pending") {
      continue;
    }
    if (body.error === "slow_down") {
      interval += 5;
      continue;
    }

    throw new Error(`OAuth token error: ${body.error}`);
  }

  throw new Error("Device authorization timed out.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
