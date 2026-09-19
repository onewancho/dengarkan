"use client";

// ============================================
// DENGARKAN — /login Page
//
// Minimalist, fast, iPhone one-hand comfortable login page:
//   • Official Logo ("dengar" in white + "kan." in #39FF14)
//   • Slogan: "Putar Musik & Podcast YouTube-mu tanpa batas"
//   • Black (#000000) & Neon Green (#39FF14) styling
//   • Friendly Indonesian loading & error states
// ============================================

import React, { useState, useEffect, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/features/auth/provider";
import { Logo } from "@/components/logo";

export default function LoginPage() {
  const router = useRouter();
  const { user, isLoading, login } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // If already logged in, send directly to /app
  useEffect(() => {
    if (!isLoading && user) {
      router.replace("/app");
    }
  }, [user, isLoading, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await login(username, password);
      router.replace("/app");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Gagal masuk. Periksa username dan password Anda.";
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="min-h-[calc(100dvh+120px)] md:min-h-dvh flex items-center justify-center px-6 py-10 bg-black">
      <div className="w-full max-w-sm">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <Logo size="lg" />
          </div>
          <p className="text-xs text-[#8E8E93] font-normal leading-relaxed">
            Putar Musik & Podcast YouTube-mu tanpa batas
          </p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="login-username"
              className="block text-xs font-medium text-[#8E8E93] mb-1.5 uppercase tracking-wider"
            >
              Username
            </label>
            <input
              id="login-username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isSubmitting}
              className="w-full px-4 py-3.5 rounded-xl bg-[#161619] border border-white/10 text-white placeholder-[#8E8E93] text-sm focus:outline-none focus:border-[#39FF14] focus:ring-1 focus:ring-[#39FF14]/40 transition-default disabled:opacity-50"
              placeholder="Masukkan username"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-xs font-medium text-[#8E8E93] mb-1.5 uppercase tracking-wider"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isSubmitting}
              className="w-full px-4 py-3.5 rounded-xl bg-[#161619] border border-white/10 text-white placeholder-[#8E8E93] text-sm focus:outline-none focus:border-[#39FF14] focus:ring-1 focus:ring-[#39FF14]/40 transition-default disabled:opacity-50"
              placeholder="Masukkan password"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="px-4 py-3 rounded-xl bg-[#FF3B30]/15 border border-[#FF3B30]/30 text-[#FF3B30] text-xs leading-relaxed"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || !username || !password}
            className="w-full py-3.5 px-6 rounded-xl bg-[#39FF14] hover:bg-[#57FF38] active:bg-[#29D60D] text-black font-bold text-sm transition-default shadow-lg glow-brand disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {isSubmitting ? (
              <span className="inline-flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin-slow text-black" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Masuk…
              </span>
            ) : (
              "Masuk & Dengarkan"
            )}
          </button>
        </form>

        {/* Features footnote */}
        <p className="mt-8 text-center text-[11px] text-[#8E8E93]/70">
          Hemat Baterai • Audio Murni • Kontrol Layar Terkunci
        </p>
      </div>
      {/* Spacer for mobile address bar auto-hide */}

    </main>
  );
}
