"use client";

// ============================================
// DENGARKAN — Global Error Handler
// Replaces default Next.js internal _global-error page.
// Must define its own <html> and <body> tags.
// ============================================

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="id">
      <body className="bg-black text-white min-h-dvh flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <h2 className="text-lg font-bold text-white mb-2">Terjadi Kesalahan</h2>
          <p className="text-xs text-[#8E8E93] mb-4">
            Terjadi masalah saat memuat aplikasi. Silakan coba muat ulang.
          </p>
          <button
            onClick={() => reset()}
            className="px-4 py-2 text-xs font-semibold rounded-xl bg-[#39FF14] text-black hover:bg-[#32e012] transition-colors cursor-pointer"
          >
            Muat Ulang
          </button>
        </div>
      </body>
    </html>
  );
}
