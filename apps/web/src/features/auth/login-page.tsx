"use client";

// ============================================
// DENGARKAN — Auth Feature: Login Page
// ============================================

import { useState, type FormEvent } from "react";
import { useAuth } from "./provider";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");

    const formData = new FormData(e.currentTarget);
    const submittedUsername = ((formData.get("username") as string) || username).trim();
    const submittedPassword = (formData.get("password") as string) || password;

    if (!submittedUsername || !submittedPassword) {
      setError("Please enter username and password.");
      return;
    }

    setUsername(submittedUsername);
    setPassword(submittedPassword);
    setIsSubmitting(true);

    try {
      await login(submittedUsername, submittedPassword);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Login failed. Please try again.";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-6 py-12">
      {/* Background glow */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-brand-500/8 blur-[120px]" />
        <div className="absolute bottom-0 left-1/4 w-[400px] h-[400px] rounded-full bg-accent/5 blur-[100px]" />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Brand */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-brand-500/15 border border-brand-500/20 mb-5 glow-brand">
            <svg
              className="w-8 h-8 text-brand-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-text-primary">
            Dengarkan
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            Audio-only listening experience
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label
              htmlFor="login-username"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              Username
            </label>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onInput={(e) => setUsername(e.currentTarget.value)}
              disabled={isSubmitting}
              className="w-full px-4 py-3 rounded-xl bg-surface-2 border border-surface-4/60 text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30 transition-default disabled:opacity-50"
              placeholder="Enter username"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-sm font-medium text-text-secondary mb-2"
            >
              Password
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onInput={(e) => setPassword(e.currentTarget.value)}
              disabled={isSubmitting}
              className="w-full px-4 py-3 rounded-xl bg-surface-2 border border-surface-4/60 text-text-primary placeholder-text-muted text-sm focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30 transition-default disabled:opacity-50"
              placeholder="Enter password"
            />
          </div>

          {error && (
            <div className="px-4 py-3 rounded-xl bg-error/10 border border-error/20 text-error text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3.5 px-6 rounded-xl bg-brand-500 hover:bg-brand-400 active:bg-brand-600 text-white font-semibold text-sm transition-default disabled:opacity-40 disabled:cursor-not-allowed glow-brand"
          >
            {isSubmitting ? (
              <span className="inline-flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin-slow" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Signing in…
              </span>
            ) : (
              "Sign In"
            )}
          </button>
        </form>

        <p className="mt-8 text-center text-xs text-text-muted/60">
          Audio-only • Low battery • Lock Screen controls
        </p>
      </div>
    </div>
  );
}
