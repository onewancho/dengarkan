"use client";

// ============================================
// DENGARKAN — /app/history Page
// Playback History with Queue-identical UI,
// Drag-and-drop reordering, Play Next, and
// 3-dots Action Menu (Add to Queue & Playlist)
// ============================================

import React, { useState, useEffect, useRef } from "react";
import { usePlayer } from "@/features/player/context";
import { usePlaylistContext } from "@/features/playlists/context";
import { parseTrackMeta } from "@/lib/track-meta";
import type { PlayableTrack } from "@/features/player/context";

const HISTORY_STORAGE_KEY = "dengarkan:play_history";
const MAX_HISTORY = 100;

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ── Add To Playlist Modal Dialog ─────────────────────────────────────────────
interface PlaylistModalProps {
  track: PlayableTrack;
  onClose: () => void;
}

function AddToPlaylistModal({ track, onClose }: PlaylistModalProps) {
  const { playlists, addTrackToPlaylist, createPlaylist } = usePlaylistContext();
  const [addedId, setAddedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSelectPlaylist = async (playlistId: string) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await addTrackToPlaylist(playlistId, {
        videoId: track.videoId,
        title: track.title,
        channelName: track.channelName,
        thumbnailUrl: track.thumbnailUrl,
        durationSeconds: track.durationSeconds,
        durationFormatted: formatDuration(track.durationSeconds),
      });
      setAddedId(playlistId);
      setTimeout(() => {
        onClose();
      }, 700);
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreateNew = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || isBusy) return;
    setIsBusy(true);
    try {
      const pl = await createPlaylist(name);
      await addTrackToPlaylist(pl.id, {
        videoId: track.videoId,
        title: track.title,
        channelName: track.channelName,
        thumbnailUrl: track.thumbnailUrl,
        durationSeconds: track.durationSeconds,
        durationFormatted: formatDuration(track.durationSeconds),
      });
      setAddedId(pl.id);
      setTimeout(() => {
        onClose();
      }, 700);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-[#161619] border border-white/10 shadow-2xl p-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 border-b border-white/10">
          <div>
            <h3 className="text-sm font-bold text-white">Tambah ke Playlist</h3>
            <p className="text-xs text-[#8E8E93] truncate max-w-[220px] mt-0.5">
              {track.title}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-[#8E8E93] hover:text-white hover:bg-white/5 transition-default cursor-pointer"
            aria-label="Tutup modal"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Existing Playlists List */}
        <div className="max-h-56 overflow-y-auto py-2 space-y-1">
          {playlists.length === 0 ? (
            <p className="text-xs text-[#8E8E93] py-4 text-center">
              Belum ada playlist. Buat playlist baru di bawah.
            </p>
          ) : (
            playlists.map((pl) => {
              const isJustAdded = addedId === pl.id;
              return (
                <button
                  key={pl.id}
                  disabled={isBusy}
                  onClick={() => handleSelectPlaylist(pl.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left text-xs font-semibold transition-default cursor-pointer ${
                    isJustAdded
                      ? "bg-[#39FF14]/15 text-[#39FF14] border border-[#39FF14]/30"
                      : "text-white hover:bg-white/5 hover:text-[#39FF14]"
                  }`}
                >
                  <span className="truncate flex-1 mr-2">{pl.name}</span>
                  {isJustAdded ? (
                    <span className="text-[11px] text-[#39FF14] flex items-center gap-1 font-bold">
                      ✓ Ditambahkan
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#8E8E93]">
                      {pl.trackCount} lagu
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Create Inline Playlist Form */}
        <div className="pt-3 border-t border-white/10">
          {isCreating ? (
            <form onSubmit={handleCreateNew} className="flex gap-2">
              <input
                type="text"
                autoFocus
                placeholder="Nama playlist..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="flex-1 bg-[#222226] border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-[#8E8E93] focus:outline-none focus:border-[#39FF14]"
              />
              <button
                type="submit"
                disabled={!newName.trim() || isBusy}
                className="px-3 py-2 rounded-xl bg-[#39FF14] text-black text-xs font-bold hover:bg-[#32e010] disabled:opacity-50 transition-default cursor-pointer"
              >
                Simpan
              </button>
            </form>
          ) : (
            <button
              onClick={() => setIsCreating(true)}
              className="w-full py-2 flex items-center justify-center gap-1.5 rounded-xl border border-white/10 text-xs font-semibold text-[#8E8E93] hover:text-white hover:bg-white/5 transition-default cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Buat Playlist Baru
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Action Menu Component ───────────────────────────────────────────────────
interface ActionMenuProps {
  track: PlayableTrack;
  onAddToQueue: () => void;
  onOpenPlaylistModal: () => void;
  onRemoveFromHistory: () => void;
}

function ActionMenu({
  track,
  onAddToQueue,
  onOpenPlaylistModal,
  onRemoveFromHistory,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="w-9 h-9 rounded-xl flex items-center justify-center text-[#8E8E93] hover:text-white hover:bg-white/5 active:bg-white/10 transition-default cursor-pointer"
        aria-label={`Menu opsi untuk ${track.title}`}
        title="Opsi lagu"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 bottom-full mb-1 w-48 rounded-2xl bg-[#161619] border border-white/10 shadow-2xl shadow-black/80 py-1.5 z-50 animate-in fade-in zoom-in-95 duration-100"
          role="menu"
        >
          {/* Tambah ke Antrean */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onAddToQueue();
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-xs font-semibold text-white hover:text-[#39FF14] hover:bg-white/5 transition-default cursor-pointer text-left"
            role="menuitem"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Tambah ke Antrean</span>
          </button>

          {/* Tambah ke Playlist */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onOpenPlaylistModal();
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-xs font-semibold text-white hover:text-[#39FF14] hover:bg-white/5 transition-default cursor-pointer text-left"
            role="menuitem"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span>Tambah ke Playlist</span>
          </button>

          <div className="border-t border-white/5 my-1" />

          {/* Hapus dari Riwayat */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onRemoveFromHistory();
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-xs font-semibold text-[#FF3B30] hover:bg-[#FF3B30]/10 transition-default cursor-pointer text-left"
            role="menuitem"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            <span>Hapus dari Riwayat</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── History Page Main Component ─────────────────────────────────────────────
export default function HistoryPage() {
  const { currentTrack, isPlaying, playTrack, addToQueue } = usePlayer();
  const [historyList, setHistoryList] = useState<PlayableTrack[]>([]);
  const [modalTrack, setModalTrack] = useState<PlayableTrack | null>(null);

  // 1. Initial load from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as PlayableTrack[];
        if (Array.isArray(parsed)) {
          setHistoryList(parsed);
        }
      }
    } catch {
      // ignore JSON parse error
    }
  }, []);

  // 2. Automatically sync newly played track to history
  useEffect(() => {
    if (!currentTrack || !currentTrack.videoId) return;

    setHistoryList((prev) => {
      const filtered = prev.filter((t) => t.videoId !== currentTrack.videoId);
      const next = [currentTrack, ...filtered].slice(0, MAX_HISTORY);
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore localStorage quota error
      }
      return next;
    });
  }, [currentTrack]);

  // Persist updated list helper
  const saveHistoryList = (newList: PlayableTrack[]) => {
    setHistoryList(newList);
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(newList));
    } catch {}
  };

  // Clear all history
  const handleClearHistory = () => {
    if (historyList.length === 0) return;
    if (window.confirm("Apakah Anda yakin ingin menghapus seluruh riwayat pemutaran?")) {
      saveHistoryList([]);
    }
  };

  // Remove individual track from history
  const handleRemoveTrack = (videoId: string) => {
    const next = historyList.filter((t) => t.videoId !== videoId);
    saveHistoryList(next);
  };

  // Click track to Play Next (starts track now, keeps existing queue next)
  const handleTrackClick = (track: PlayableTrack) => {
    void playTrack(track, false);
  };

  return (
    <div className="w-full pt-4 pb-36">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#39FF14]/10 border border-[#39FF14]/20 text-[#39FF14] text-xs font-semibold mb-2">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              {historyList.length} lagu diputar
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              Riwayat Pemutaran
            </h1>
          </div>

          {historyList.length > 0 && (
            <button
              onClick={handleClearHistory}
              className="text-xs text-[#8E8E93] hover:text-[#FF3B30] transition-default px-3 py-1.5 rounded-lg hover:bg-white/5 cursor-pointer font-medium"
            >
              Bersihkan
            </button>
          )}
        </div>
      </div>

      {/* History Track List */}
      <div className="space-y-1.5">
        {historyList.length === 0 ? (
          <div className="text-center py-16 px-4">
            <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto mb-3 text-[#8E8E93]">
              <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
            <h3 className="text-base font-semibold text-white mb-1">
              Belum Ada Riwayat
            </h3>
            <p className="text-xs text-[#8E8E93] max-w-xs mx-auto">
              Lagu yang Anda putar akan otomatis tercatat di sini.
            </p>
          </div>
        ) : (
          historyList.map((item, idx) => {
            const meta = parseTrackMeta(item.title, item.channelName, item.durationSeconds);
            const isCurrent = currentTrack?.videoId === item.videoId;

            return (
              <div
                key={`${item.videoId}-${idx}`}
                className={`flex items-center gap-2 p-2.5 rounded-xl transition-all duration-150 ${
                  isCurrent
                    ? "bg-[#39FF14]/10 border border-[#39FF14]/30 shadow-md shadow-[#39FF14]/5"
                    : "bg-white/5 hover:bg-white/10 border border-transparent"
                }`}
              >
                {/* Number or Equalizer */}
                <div className="w-6 flex items-center justify-center flex-shrink-0">
                  {isCurrent && isPlaying ? (
                    <div className="w-3.5 h-3.5 flex items-end gap-0.5">
                      <span className="w-0.5 h-3 bg-[#39FF14] animate-pulse" />
                      <span className="w-0.5 h-1.5 bg-[#39FF14] animate-pulse delay-75" />
                      <span className="w-0.5 h-3 bg-[#39FF14] animate-pulse delay-150" />
                    </div>
                  ) : (
                    <span
                      className={`text-xs tabular-nums font-medium ${
                        isCurrent
                          ? "text-[#39FF14] font-bold"
                          : "text-[#8E8E93]"
                      }`}
                    >
                      {idx + 1}
                    </span>
                  )}
                </div>

                {/* Thumbnail (Identical to Queue) */}
                <div
                  onClick={() => handleTrackClick(item)}
                  className="relative w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-[#161619] border border-white/10 cursor-pointer"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                  {isCurrent && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <span className="w-2 h-2 rounded-full bg-[#39FF14]" />
                    </div>
                  )}
                </div>

                {/* Track Info — Clickable to Play Next */}
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left cursor-pointer focus:outline-none"
                  onClick={() => handleTrackClick(item)}
                  aria-label={`Putar ${item.title}`}
                >
                  <div className="flex items-center gap-1.5">
                    {isCurrent && (
                      <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-[#39FF14] text-black">
                        Diputar
                      </span>
                    )}
                    <p
                      className={`text-xs font-semibold truncate leading-tight ${
                        isCurrent ? "text-[#39FF14]" : "text-white"
                      }`}
                    >
                      {meta.title}
                    </p>
                  </div>
                  <p className={`text-[11px] font-medium truncate mt-0.5 ${isCurrent ? "text-white/90" : "text-[#8E8E93]"}`}>
                    {meta.artist}
                  </p>
                  <p className="text-[10px] text-[#8E8E93]/70 truncate">
                    {meta.channelInfo}
                  </p>
                </button>

                {/* 3-dots Action Menu */}
                <ActionMenu
                  track={item}
                  onAddToQueue={() => addToQueue(item)}
                  onOpenPlaylistModal={() => setModalTrack(item)}
                  onRemoveFromHistory={() => handleRemoveTrack(item.videoId)}
                />
              </div>
            );
          })
        )}
      </div>

      {/* Add To Playlist Modal Dialog */}
      {modalTrack && (
        <AddToPlaylistModal
          track={modalTrack}
          onClose={() => setModalTrack(null)}
        />
      )}
    </div>
  );
}
