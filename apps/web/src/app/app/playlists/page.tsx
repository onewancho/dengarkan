"use client";

// ============================================
// DENGARKAN — /app/playlists Page
//
// Playlist overview list:
//   • Create new playlist (optimistic)
//   • Rename and delete playlists (optimistic with rollback)
//   • Tap playlist opens /app/playlists/:id
// ============================================

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { usePlaylistContext } from "@/features/playlists/context";
import type { Playlist } from "@dengarkan/shared";

function CreatePlaylistInline({ onDone }: { onDone: () => void }) {
  const { createPlaylist } = usePlaylistContext();
  const [name,   setName]   = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsBusy(true);
    try {
      await createPlaylist(trimmed);
      onDone();
    } catch {
      // toast shown in hook
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 p-3 rounded-2xl bg-[#161619] border border-white/10 mb-4">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nama daftar putar baru…"
        maxLength={200}
        className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder-[#8E8E93] focus:outline-none"
      />
      <button
        type="submit"
        disabled={isBusy || !name.trim()}
        className="text-xs font-bold px-4 py-2 rounded-xl bg-[#39FF14] text-black disabled:opacity-40 transition-default cursor-pointer min-h-[36px]"
      >
        {isBusy ? "…" : "Buat"}
      </button>
      <button
        type="button"
        onClick={onDone}
        className="text-xs text-[#8E8E93] hover:text-white px-2 py-2 cursor-pointer"
      >
        ✕
      </button>
    </form>
  );
}

function RenameInline({
  playlist,
  onDone,
}: {
  playlist: Playlist;
  onDone: () => void;
}) {
  const { renamePlaylist } = usePlaylistContext();
  const [name,   setName]   = useState(playlist.name);
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === playlist.name) { onDone(); return; }
    setIsBusy(true);
    try {
      await renamePlaylist(playlist.id, trimmed);
    } catch {
      // rollback handled in hook
    } finally {
      setIsBusy(false);
      onDone();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-1.5 min-w-0">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={handleSubmit}
        className="flex-1 min-w-0 text-sm text-white bg-[#222226] rounded-lg px-2.5 py-1.5 focus:outline-none border border-[#39FF14]/50"
      />
      <button type="submit" disabled={isBusy} className="text-xs text-[#39FF14] font-bold px-2 py-1">
        {isBusy ? "…" : "✓"}
      </button>
    </form>
  );
}

export default function PlaylistsPage() {
  const router = useRouter();
  const { playlists, isLoading, deletePlaylist } = usePlaylistContext();

  const [showCreate, setShowCreate] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  return (
    <div className="w-full pt-4 pb-36">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
            Daftar Putar
          </h1>
          <p className="text-xs sm:text-sm text-[#8E8E93] mt-0.5 font-medium">
            Koleksi musik dan podcast tersimpanmu
          </p>
        </div>

        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl bg-[#39FF14] text-black text-xs font-bold shadow-md hover:bg-[#57FF38] active:scale-95 transition-default cursor-pointer min-h-[44px]"
          aria-label="Buat daftar putar baru"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span className="hidden sm:inline">Playlist Baru</span>
          <span className="sm:hidden">Baru</span>
        </button>
      </div>

      {showCreate && (
        <CreatePlaylistInline onDone={() => setShowCreate(false)} />
      )}

      {/* Loading Skeletons */}
      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-2xl bg-[#121214] border border-white/5 animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && playlists.length === 0 && !showCreate && (
        <div className="text-center py-20 px-4">
          <div className="w-14 h-14 rounded-2xl bg-[#161619] border border-white/10 flex items-center justify-center mx-auto mb-3 text-[#8E8E93]">
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <p className="text-base font-bold text-white">Belum ada playlist</p>
          <p className="text-xs text-[#8E8E93] mt-1 max-w-xs mx-auto">
            Buat daftar putar pertamamu untuk menyimpan lagu dan podcast favorit.
          </p>
        </div>
      )}

      {/* Playlists List */}
      {!isLoading && playlists.length > 0 && (
        <div className="space-y-2">
          {playlists.map((pl) => {
            const isDeleting = deletingId === pl.id;

            return (
              <div
                key={pl.id}
                className="group flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#121214] hover:bg-[#18181B] border border-white/5 transition-default"
              >
                {/* Playlist Icon */}
                <div className="w-11 h-11 rounded-xl bg-[#222226] flex items-center justify-center flex-shrink-0 text-[#39FF14] border border-white/5">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                  </svg>
                </div>

                {/* Name / Rename Input */}
                {renamingId === pl.id ? (
                  <RenameInline playlist={pl} onDone={() => setRenamingId(null)} />
                ) : (
                  <button
                    onClick={() => router.push(`/app/playlists/${pl.id}`)}
                    className="flex-1 min-w-0 text-left cursor-pointer focus:outline-none"
                    aria-label={`Buka playlist ${pl.name}`}
                  >
                    <h3 className="text-sm font-bold text-white truncate group-hover:text-[#39FF14] transition-default">
                      {pl.name}
                    </h3>
                    <p className="text-xs text-[#8E8E93] mt-0.5">
                      {pl.trackCount} {pl.trackCount === 1 ? "lagu" : "lagu"}
                    </p>
                  </button>
                )}

                {/* Actions */}
                {renamingId !== pl.id && (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => setRenamingId(pl.id)}
                      className="w-10 h-10 rounded-xl flex items-center justify-center text-[#8E8E93] hover:text-white hover:bg-white/5 transition-default"
                      aria-label="Ubah nama playlist"
                      title="Ubah nama"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button
                      disabled={isDeleting}
                      onClick={async () => {
                        setDeletingId(pl.id);
                        try { await deletePlaylist(pl.id); }
                        catch { /* rollback handled in hook */ }
                        finally { setDeletingId(null); }
                      }}
                      className="w-10 h-10 rounded-xl flex items-center justify-center text-[#8E8E93] hover:text-[#FF3B30] hover:bg-white/5 transition-default disabled:opacity-40"
                      aria-label="Hapus playlist"
                      title="Hapus"
                    >
                      {isDeleting ? (
                        <span className="text-xs">…</span>
                      ) : (
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
