"use client";

import { useState } from "react";

export function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", { method: "POST" });
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.error) {
        setError(data.error);
        return;
      }
      if (data.url) {
        window.open(data.url, "_blank");
      }
    } catch {
      setError("Failed to start login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight text-white">
            Antigravity Chat
          </h1>
          <p className="text-zinc-400 text-lg">
            Free access to Gemini models. No API key needed.
          </p>
        </div>

        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full rounded-lg bg-white px-6 py-3 text-base font-semibold text-zinc-900 transition hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Starting..." : "Sign in with Google"}
        </button>

        {error && (
          <p className="text-red-400 text-sm">{error}</p>
        )}

        <p className="text-zinc-600 text-xs">
          Uses Antigravity OAuth to authenticate with Google.
          Your tokens are stored locally on this machine.
        </p>
      </div>
    </div>
  );
}
