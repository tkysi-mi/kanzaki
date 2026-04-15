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

// ── OAuth Authorization Code Flow (PKCE) ─────────────────

import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import open from "open";

const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "openai-codex"; // OpenClaw compatibility
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function loginWithOAuthPKCE(): Promise<TokenResponse> {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString('base64url');
  
  const authUrl = `${OPENAI_AUTH_URL}?response_type=code&client_id=${OPENAI_CLIENT_ID}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openai.public&state=${state}`;

  console.log("Opening browser for authentication...");
  console.log("If your browser does not open automatically, please open this link:");
  console.log(authUrl);
  
  try {
    await open(authUrl);
  } catch {
    // Ignore error if `open` fails (e.g. no default browser found)
  }

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (!req.url?.startsWith('/auth/callback')) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');

        if (!code) {
          res.writeHead(400);
          res.end("Missing code");
          server.close();
          return reject(new Error("No authorization code received"));
        }

        if (returnedState !== state) {
           res.writeHead(400);
           res.end("Invalid state");
           server.close();
           return reject(new Error("OAuth state mismatch"));
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end("<h1>Authentication Successful!</h1><p>You can close this tab and return to your terminal.</p>");

        server.close();

        // Exchange code for token
        const tokenRes = await fetch(OPENAI_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: OPENAI_CLIENT_ID,
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI
          })
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          return reject(new Error(`Token exchange failed: ${tokenRes.status} ${body}`));
        }

        const tokenData = await tokenRes.json() as TokenResponse;
        resolve(tokenData);

      } catch (err) {
         res.writeHead(500);
         res.end("Internal Server Error");
         server.close();
         reject(err);
      }
    });

    server.listen(1455, '127.0.0.1');
  });
}


