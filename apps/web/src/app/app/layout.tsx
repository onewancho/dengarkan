"use client";

// ============================================
// DENGARKAN — App Shell Layout (/app/*)
//
// Persistent Audio & Playlist Shell:
//   • Houses single PlayerProvider & PlaylistProvider (zero playback interruption)
//   • Top navigation bar with Logo & Logout
//   • Persistent AudioPlayer (Mini Player + Full Player)
//   • Bottom Tab Bar (/app, /app/queue, /app/playlists)
//   • Mobile-first one-hand thumb friendly targets (>= 44px)
// ============================================

import React, { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/features/auth/provider";
import { PlayerProvider } from "@/features/player/context";
import { PlaylistProvider } from "@/features/playlists/context";
import { AudioPlayer } from "@/features/player/audio-player";
import { Logo } from "@/components/logo";

function TabBar() {
  const pathname = usePathname();

  const isSearch    = pathname === "/app";
  const isQueue     = pathname === "/app/queue";
  const isHistory   = pathname === "/app/history";
  const isPlaylists = pathname ? pathname.startsWith("/app/playlists") : false;

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 glass safe-bottom border-t border-white/10 h-[var(--tabbar-height)] flex items-start"
      role="navigation"
      aria-label="Navigasi Utama"
    >
      <div className="flex items-center justify-around max-w-lg mx-auto px-2 sm:px-4 w-full h-[56px]">
        {/* Tab 1: Home / Cari */}
        <Link
          href="/app"
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl transition-default ${
            isSearch ? "text-[#39FF14]" : "text-[#8E8E93] hover:text-white"
          }`}
          aria-label="Cari dan Beranda"
          aria-current={isSearch ? "page" : undefined}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <span className="text-[10px] font-semibold mt-1">Cari</span>
        </Link>

        {/* Tab 2: Queue */}
        <Link
          href="/app/queue"
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl transition-default ${
            isQueue ? "text-[#39FF14]" : "text-[#8E8E93] hover:text-white"
          }`}
          aria-label="Antrean Pemutaran"
          aria-current={isQueue ? "page" : undefined}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          <span className="text-[10px] font-semibold mt-1">Queue</span>
        </Link>

        {/* Tab 3: History */}
        <Link
          href="/app/history"
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl transition-default ${
            isHistory ? "text-[#39FF14]" : "text-[#8E8E93] hover:text-white"
          }`}
          aria-label="Riwayat Pemutaran"
          aria-current={isHistory ? "page" : undefined}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span className="text-[10px] font-semibold mt-1">History</span>
        </Link>

        {/* Tab 4: Playlists */}
        <Link
          href="/app/playlists"
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] rounded-xl transition-default ${
            isPlaylists ? "text-[#39FF14]" : "text-[#8E8E93] hover:text-white"
          }`}
          aria-label="Daftar Putar"
          aria-current={isPlaylists ? "page" : undefined}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <span className="text-[10px] font-semibold mt-1">Playlist</span>
        </Link>
      </div>
    </nav>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, isLoading, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  useEffect(() => {
    if (!isLoading && !user && !isLoggingOut) {
      router.replace("/login");
    }
  }, [user, isLoading, isLoggingOut, router]);

  const handleLogout = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    try {
      await logout();
    } catch {
      // Non-fatal
    }
    window.location.replace("/login");
  };

  if (isLoading || !user) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-black">
        <div className="flex flex-col items-center gap-3">
          <Logo size="md" />
          <div className="w-5 h-5 border-2 border-[#39FF14] border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <PlayerProvider>
      <PlaylistProvider>
        <div className="flex flex-col min-h-[calc(100dvh+120px)] md:min-h-dvh bg-black text-white selection:bg-[#39FF14] selection:text-black">
          {/* Top Bar with safe-top for iPhone notch & Dynamic Island */}
          <header className="sticky top-0 z-30 glass border-b border-white/10 px-4 safe-top pb-3">
            <div className="flex items-center justify-between max-w-2xl mx-auto w-full">
              <Link href="/app" className="flex items-center gap-2 focus:outline-none" aria-label="Beranda Dengarkan">
                <Logo size="sm" />
              </Link>

              <div className="flex items-center gap-3">
                <span className="text-xs text-[#8E8E93] hidden sm:inline">
                  Halo, <strong className="text-white font-semibold">{user.username}</strong>
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                  className="text-xs font-medium text-[#8E8E93] hover:text-[#FF3B30] active:text-[#FF3B30] px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 active:bg-white/15 transition-default min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer select-none touch-manipulation disabled:opacity-50"
                  aria-label="Keluar dari akun"
                >
                  {isLoggingOut ? (
                    <span className="flex items-center gap-1.5 text-xs text-[#8E8E93]">
                      <svg className="w-3.5 h-3.5 animate-spin-slow text-[#FF3B30]" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Keluar…
                    </span>
                  ) : (
                    "Keluar"
                  )}
                </button>
              </div>
            </div>
          </header>

          {/* Main content area */}
          <main className="flex-1 max-w-2xl mx-auto w-full px-4 flex flex-col min-h-0">
            {children}
          </main>

          {/* Persistent AudioPlayer (Mini Player docked above TabBar, Full Player full-screen modal) */}
          <AudioPlayer />

          {/* Bottom Navigation Tab Bar */}
          <TabBar />
        </div>
      </PlaylistProvider>
    </PlayerProvider>
  );
}
