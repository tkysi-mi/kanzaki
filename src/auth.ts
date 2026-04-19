import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const CONFIG_DIR = resolve(homedir(), ".config", "kanzaki");
const CREDENTIALS_PATH = resolve(CONFIG_DIR, "credentials.json");

/**
 * 認証情報ファイルの絶対パスを返す（プラットフォーム依存の表示用）。
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}

export interface StoredCredentials {
  provider: "openai" | "anthropic";
  apiKey: string;
  /** OAuth token (if authenticated via OAuth) */
  oauthToken?: string;
  /** Token expiry (ISO string) */
  expiresAt?: string;
  /** Claude CLIをサブプロセスとして利用するフラグ */
  useClaudeCli?: boolean;
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
 * Unix系では 0600 権限を設定して本人以外読めないようにする。
 */
export function saveCredentials(credentials: StoredCredentials): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify(credentials, null, 2),
    "utf-8",
  );
  if (process.platform !== "win32") {
    try {
      chmodSync(CREDENTIALS_PATH, 0o600);
    } catch {
      // 権限設定失敗は致命的でないのでスキップ
    }
  }
}

/**
 * 保存済み認証情報を削除する。削除対象が存在したかどうかを返す。
 */
export function clearCredentials(): boolean {
  if (!existsSync(CREDENTIALS_PATH)) return false;
  unlinkSync(CREDENTIALS_PATH);
  return true;
}

/**
 * 有効なAPIキーを取得する。
 * OAuth tokenがある場合はそちらを優先（有効期限チェック付き）。
 */
export function getActiveApiKey(creds: StoredCredentials): string {
  // Claude CLIを使う場合は、APIキーはsubprocess側で管理するのでダミー値を返す
  if (creds.useClaudeCli) {
    return "claude-cli";
  }

  // OAuthトークンが有効ならそれを使う
  if (creds.oauthToken) {
    // expiresAtが未設定（Claudeセッショントークン等）なら常に有効とみなす
    if (!creds.expiresAt) {
      return creds.oauthToken;
    }
    const expiry = new Date(creds.expiresAt);
    if (expiry > new Date()) {
      return creds.oauthToken;
    }
  }

  // フォールバック: 通常のAPIキー
  return creds.apiKey;
}

// ── OAuth Authorization Code Flow (PKCE) ─────────────────

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import open from "open";

const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Correct client ID used by the platform
const REDIRECT_URI = "http://localhost:1455/auth/callback";

export interface TokenResponse {
  access_token: string;
  expires_in: number;
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function loginWithOAuthPKCE(): Promise<TokenResponse> {
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("base64url");

  const scope = encodeURIComponent(
    "openid profile email offline_access api.connectors.read api.connectors.invoke",
  );
  const authUrl = `${OPENAI_AUTH_URL}?response_type=code&client_id=${OPENAI_CLIENT_ID}&code_challenge=${challenge}&code_challenge_method=S256&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&state=${state}&id_token_add_organizations=true&codex_cli_simplified_flow=true`;

  console.log("Opening browser for authentication...");
  console.log(
    "If your browser does not open automatically, please open this link:",
  );
  console.log(authUrl);

  try {
    await open(authUrl);
  } catch {
    // Ignore error if `open` fails (e.g. no default browser found)
  }

  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;

    const finish = (result: TokenResponse | Error) => {
      if (timeout) clearTimeout(timeout);
      server.close();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const server = createServer(async (req, res) => {
      try {
        if (!req.url?.startsWith("/auth/callback")) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
          const body = `<h1>Authentication Failed</h1><p>${escapeHtml(error)}: ${escapeHtml(errorDesc || "Unknown error")}</p>`;
          res.end(body);
          return finish(new Error(`OAuth error: ${error} - ${errorDesc}`));
        }

        if (!code) {
          res.writeHead(400);
          res.end("Missing authorization code");
          return finish(new Error("No authorization code received"));
        }

        if (returnedState !== state) {
          res.writeHead(400);
          res.end("Invalid state");
          return finish(new Error("OAuth state mismatch"));
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authentication Successful!</h1><p>You can close this tab and return to your terminal.</p>",
        );

        // Exchange code for token
        const tokenRes = await fetch(OPENAI_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: OPENAI_CLIENT_ID,
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
          }),
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          return finish(
            new Error(`Token exchange failed: ${tokenRes.status} ${body}`),
          );
        }

        const tokenData = (await tokenRes.json()) as TokenResponse;
        finish(tokenData);
      } catch (err) {
        res.writeHead(500);
        res.end("Internal Server Error");
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    server.on("error", (err) => {
      finish(
        new Error(`OAuth callback server failed to start: ${err.message}`),
      );
    });

    // 5分経ってもコールバックが来なければタイムアウト
    timeout = setTimeout(
      () => {
        finish(new Error("OAuth authentication timed out after 5 minutes"));
      },
      5 * 60 * 1000,
    );

    server.listen(1455, "localhost");
  });
}
