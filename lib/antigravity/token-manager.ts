import {
  loadTokens,
  saveTokens,
  type AntigravityTokens,
} from "./token-store";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
} from "./constants";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const EXPIRY_BUFFER_MS = 60_000;

function isExpired(tokens: AntigravityTokens): boolean {
  if (tokens.expiresIn == null) return true;
  const expiresAt = tokens.obtainedAt + tokens.expiresIn * 1000;
  return Date.now() >= expiresAt - EXPIRY_BUFFER_MS;
}

async function refreshAccessToken(
  tokens: AntigravityTokens,
): Promise<AntigravityTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || data.error) {
    throw new Error(
      `Token refresh failed: ${data.error_description ?? data.error ?? res.statusText}`,
    );
  }

  if (!data.access_token) {
    throw new Error("Refresh response missing access_token");
  }

  const refreshed: AntigravityTokens = {
    accessToken: data.access_token,
    refreshToken: tokens.refreshToken,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
    tokenType: data.token_type ?? tokens.tokenType,
    scope: data.scope ?? tokens.scope,
    obtainedAt: Date.now(),
  };

  await saveTokens(refreshed);
  return refreshed;
}

export async function getValidAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens) throw new Error("Not authenticated — no tokens found");

  if (isExpired(tokens)) {
    const refreshed = await refreshAccessToken(tokens);
    return refreshed.accessToken;
  }

  return tokens.accessToken;
}
