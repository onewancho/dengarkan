"use client";

// ============================================
// DENGARKAN — Super Admin Shell Layout (/admin/*)
//
// Exclusive shell for 'maswaw':
//   • Route protection (unauthorized users redirected to /app or /login)
//   • Standalone layout: NO player engine, NO /app bottom navigation
//   • Dedicated top header with branding, SUPER ADMIN badge, and logout
//   • iPhone safe-area padding & mobile-first styling
// ============================================

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/features/auth/provider";
import { Logo } from "@/components/logo";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, isLoading, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // Strict route protection
  useEffect(() => {
    if (!isLoading && !isLoggingOut) {
      if (!user) {
        router.replace("/login");
      } else if (user.username.toLowerCase() !== "maswaw") {
        router.replace("/app");
      }
    }
  }, [user, isLoading, isLoggingOut, router]);

  const handleLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await logout();
    } catch {
      // Non-fatal fallback
    }
    window.location.replace("/login");
  };

  // Loading or redirecting state
  if (isLoading || !user || user.username.toLowerCase() !== "maswaw") {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-3">
          <Logo size="md" />
          <div className="w-5 h-5 border-2 border-[#39FF14] border-t-transparent rounded-full animate-spin" />
          <span className="text-[11px] text-[#8E8E93] tracking-wide">Memverifikasi Hak Akses Super Admin…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-dvh bg-black text-white selection:bg-[#39FF14] selection:text-black">
      {/* Top Header */}
      <header className="sticky top-0 z-30 glass border-b border-white/10 px-4 safe-top pb-3">
        <div className="flex items-center justify-between max-w-2xl mx-auto w-full pt-2">
          {/* Brand & Super Admin Badge */}
          <div className="flex items-center gap-2.5">
            <Link href="/admin" className="flex items-center focus:outline-none" aria-label="Beranda Admin">
              <Logo size="sm" />
            </Link>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase bg-[#39FF14]/15 border border-[#39FF14]/30 text-[#39FF14] glow-brand">
              Super Admin
            </span>
          </div>

          {/* User info & Logout */}
          <div className="flex items-center gap-3">
            <div className="hidden xs:flex flex-col items-end text-right">
              <span className="text-xs font-semibold text-white leading-tight">maswaw</span>
              <span className="text-[10px] text-[#8E8E93] leading-tight">Administrator</span>
            </div>

            <button
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/5 hover:bg-[#FF3B30]/15 active:bg-[#FF3B30]/25 text-[#8E8E93] hover:text-[#FF3B30] border border-white/10 hover:border-[#FF3B30]/30 transition-default text-xs font-medium cursor-pointer disabled:opacity-50"
              aria-label="Keluar dari akun admin"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              <span>{isLoggingOut ? "Keluar…" : "Keluar"}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-6 safe-bottom">
        {children}
      </main>
    </div>
  );
}
