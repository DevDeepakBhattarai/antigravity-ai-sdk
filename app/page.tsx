"use client";

import { useEffect, useState } from "react";
import { Chat } from "@/components/chat";
import { LoginScreen } from "@/components/login-screen";

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/status");
        const data = (await res.json()) as { authenticated: boolean };
        setAuthenticated(data.authenticated);
      } catch {
        setAuthenticated(false);
      }
    }
    checkAuth();

    // Re-check auth when the window regains focus (user may have completed OAuth in another tab)
    function onFocus() {
      checkAuth();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Also check for ?auth=success query param (redirect from OAuth callback)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "success") {
      setAuthenticated(true);
      // Clean up the URL
      window.history.replaceState({}, "", "/");
    }
  }, []);

  if (authenticated === null) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950">
        <p className="text-zinc-500 text-sm">Loading...</p>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginScreen />;
  }

  return <Chat />;
}
