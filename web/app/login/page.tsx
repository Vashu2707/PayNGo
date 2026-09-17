"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dbDown, setDbDown] = useState(false);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/auth/setup-status");
      const data = await res.json();
      if (res.status === 503) {
        setDbDown(true);
        return;
      }
      setSetupComplete(data.setupComplete === true);
      setMode(data.setupComplete === true ? "login" : "setup");
    })();
  }, []);

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === "setup") {
        if (password !== confirm) {
          setError("Passwords do not match.");
          setBusy(false);
          return;
        }
        if (password.length < 8) {
          setError("Password must be at least 8 characters.");
          setBusy(false);
          return;
        }
        const res = await fetch("/api/auth/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Setup failed.");
          setBusy(false);
          return;
        }
        // Auto-login after setup.
        const login = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (login.ok) {
          router.push("/dashboard");
          router.refresh();
        } else {
          router.push("/");
          router.refresh();
        }
      } else {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Login failed.");
          setBusy(false);
          return;
        }
        router.push("/dashboard");
        router.refresh();
      }
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }, [mode, username, password, confirm, router]);

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-logo">🛒</div>
        <h1>PayNGo</h1>
        <p className="auth-subtitle">
          {mode === "setup" ? "Create the owner account to get started" : "Sign in to your dashboard"}
        </p>

        {dbDown ? (
          <div className="auth-error">Database is unavailable. Please check your MongoDB connection and reload.</div>
        ) : (
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="auth-label">Username</label>
            <input
              className="auth-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />

            <label className="auth-label">Password</label>
            <input
              className="auth-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "setup" ? "new-password" : "current-password"}
              required
            />

            {mode === "setup" && (
              <>
                <label className="auth-label">Confirm password</label>
                <input
                  className="auth-input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </>
            )}

            {error && <div className="auth-error">{error}</div>}

            <button className="auth-submit" type="submit" disabled={busy}>
              {busy ? "…" : mode === "setup" ? "Create Account" : "Sign In"}
            </button>

            <div className="auth-foot">
              <button
                type="button"
                className="auth-link"
                onClick={() => {
                  router.push("/");
                  router.refresh();
                }}
              >
                Back to store
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
