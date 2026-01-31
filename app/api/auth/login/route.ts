import { NextResponse } from "next/server";
import { createServer, type Server } from "node:http";
import { URL } from "node:url";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_HEADERS,
} from "@/lib/antigravity/constants";
import { saveTokens, type AntigravityTokens } from "@/lib/antigravity/token-store";

const LISTENER_PORT = 51121;
const TIMEOUT_MS = 3 * 60 * 1000;

let activeServer: Server | null = null;

function buildAuthUrl(): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

async function exchangeCode(code: string): Promise<AntigravityTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      ...ANTIGRAVITY_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || data.error) {
    throw new Error(data.error_description ?? data.error ?? "Token exchange failed");
  }

  if (!data.access_token || !data.refresh_token) {
    throw new Error("Missing tokens in exchange response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
    tokenType: data.token_type ?? null,
    scope: data.scope ?? null,
    obtainedAt: Date.now(),
  };
}

function startCallbackServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activeServer) {
      activeServer.close();
      activeServer = null;
    }

    const server = createServer((req, res) => {
      if (!req.url) { res.statusCode = 400; res.end("No URL"); return; }

      const parsed = new URL(req.url, `http://localhost:${LISTENER_PORT}`);
      if (parsed.pathname !== "/oauth-callback") { res.statusCode = 404; res.end("Not found"); return; }

      const error = parsed.searchParams.get("error");
      if (error) {
        res.statusCode = 302;
        res.setHeader("Location", `http://localhost:3000?auth=error&message=${encodeURIComponent(error)}`);
        res.end();
        cleanup();
        return;
      }

      const code = parsed.searchParams.get("code");
      if (!code) { res.statusCode = 400; res.end("Missing code"); return; }

      void (async () => {
        try {
          const tokens = await exchangeCode(code);
          await saveTokens(tokens);
          res.statusCode = 302;
          res.setHeader("Location", "http://localhost:3000?auth=success");
          res.end();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Exchange failed";
          res.statusCode = 302;
          res.setHeader("Location", `http://localhost:3000?auth=error&message=${encodeURIComponent(msg)}`);
          res.end();
        } finally {
          cleanup();
        }
      })();
    });

    const timeout = setTimeout(() => {
      cleanup();
    }, TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeout);
      if (activeServer === server) activeServer = null;
      server.close();
    }

    activeServer = server;

    server.once("error", (err) => {
      activeServer = null;
      reject(err);
    });

    server.listen(LISTENER_PORT, () => {
      console.log(`[antigravity] OAuth callback server on port ${LISTENER_PORT}`);
      resolve();
    });
  });
}

export async function POST() {
  try {
    await startCallbackServer();
    const authUrl = buildAuthUrl();
    return NextResponse.json({ url: authUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to start OAuth";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
