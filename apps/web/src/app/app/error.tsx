"use client";

// ============================================
// DENGARKAN — App Error Boundary (/app/error.tsx)
//
// Catches client-side exceptions and ChunkLoadError
// within the authenticated /app shell.
// Automatically reloads on chunk mismatches (deployments)
// with a 10-second debounce to prevent reload loops.
// ============================================

import React, { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // If it's a chunk load error caused by a new deployment or stale CDN cache, auto-reload once
    if (
      error.name === "ChunkLoadError" ||
      error.message?.includes("Failed to load chunk")
    ) {
      const lastReload = sessionStorage.getItem("chunk_reload_ts");
      const now = Date.now();
      if (!lastReload || now - Number(lastReload) > 10000) {
        sessionStorage.setItem("chunk_reload_ts", String(now));
        window.location.reload();
      }
    }
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center py-10 px-6 rounded-3xl bg-[#161619] border border-white/10 shadow-2xl">
        <div className="w-12 h-12 rounded-2xl bg-[#FF3B30]/15 border border-[#FF3B30]/20 flex items-center justify-center mx-auto mb-4 text-[#FF3B30]">
          <svg
            className="w-6 h-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>

        <h2 className="text-base font-bold text-white mb-1.5">
          Halaman Gagal Dimuat
        </h2>
        <p className="text-xs text-[#8E8E93] mb-6 leading-relaxed">
          Terjadi kendala saat memuat data atau terdapat versi pembaruan aplikasi yang belum sinkron di browsermu.
        </p>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full py-3 px-4 rounded-xl bg-[#39FF14] hover:bg-[#57FF38] active:scale-95 text-black text-xs font-bold transition-default cursor-pointer"
          >
            Muat Ulang Halaman
          </button>
          <button
            type="button"
            onClick={() => reset()}
            className="w-full py-2.5 px-4 rounded-xl bg-white/5 hover:bg-white/10 text-[#8E8E93] hover:text-white text-xs font-medium transition-default cursor-pointer"
          >
            Coba Lagi
          </button>
        </div>
      </div>
    </div>
  );
}
