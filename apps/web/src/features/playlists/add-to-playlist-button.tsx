"use client";

// ============================================
// DENGARKAN — Add to Playlist Button
//
// Shows a popover listing all playlists.
// User can tap a playlist to add the track,
// or create a new playlist inline.
// ============================================

import React, { useState, useRef, useEffect } from "react";
import type { SearchResult, QueueTrack, PlaylistTrack } from "@dengarkan/shared";
import { usePlaylistContext } from "./context";

interface Props {
  track: SearchResult | QueueTrack | PlaylistTrack;
  className?: string;
}

export function AddToPlaylistButton({ track, className = "" }: Props) {
  const { playlists, addTrackToPlaylist, createPlaylist } = usePlaylistContext();
  const [open,      setOpen]      = useState(false);
  const [added,     setAdded]     = useState<string | null>(null); // playlist id just added to
  const [creating,  setCreating]  = useState(false);
  const [newName,   setNewName]   = useState("");
  const [isBusy,    setIsBusy]    = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleAdd = async (playlistId: string) => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await addTrackToPlaylist(playlistId, {
        videoId: track.videoId,
        title: track.title,
        channelName: track.channelName,
        thumbnailUrl: track.thumbnailUrl,
        durationSeconds: track.durationSeconds,
        durationFormatted: "durationFormatted" in track ? track.durationFormatted : "Audio",
      });
      setAdded(playlistId);
      setTimeout(() => {
        setAdded(null);
        setOpen(false);
      }, 800);
    } finally {
      setIsBusy(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setIsBusy(true);
    try {
      const pl = await createPlaylist(name);
      await addTrackToPlaylist(pl.id, {
        videoId: track.videoId,
        title: track.title,
        channelName: track.channelName,
        thumbnailUrl: track.thumbnailUrl,
        durationSeconds: track.durationSeconds,
        durationFormatted: "durationFormatted" in track ? track.durationFormatted : "Audio",
      });
      setAdded(pl.id);
      setTimeout(() => {
        setAdded(null);
        setOpen(false);
        setCreating(false);
        setNewName("");
      }, 800);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="min-w-[40px] min-h-[40px] rounded-xl border bg-[#18181B] hover:bg-[#222226] border-white/5 text-[#8E8E93] hover:text-white flex items-center justify-center transition-default cursor-pointer"
        aria-label="Tambah ke playlist"
        aria-expanded={open}
        title="Tambah ke playlist"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <div
          className="absolute right-0 bottom-full mb-2 w-56 rounded-2xl bg-[#161619] border border-white/10 shadow-2xl shadow-black/80 overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-150"
          role="menu"
        >
          <div className="px-3.5 pt-3 pb-1 text-[10px] font-bold text-[#8E8E93] uppercase tracking-wider">
            Simpan ke Playlist
          </div>

          <div className="max-h-48 overflow-y-auto py-1 scrollbar-thin">
            {playlists.length === 0 && !creating && (
              <div className="px-3.5 py-3 text-xs text-[#8E8E93] italic">Belum ada playlist</div>
            )}
            {playlists.map((pl) => {
              const isAdded = added === pl.id;
              return (
                <button
                  key={pl.id}
                  disabled={isBusy}
                  onClick={() => handleAdd(pl.id)}
                  className={`w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs font-semibold text-left transition-default cursor-pointer ${
                    isAdded ? "text-[#39FF14] bg-[#39FF14]/10" : "text-white hover:bg-white/5"
                  }`}
                  role="menuitem"
                >
                  <span className="truncate">{pl.name}</span>
                  {isAdded && (
                    <svg className="w-3.5 h-3.5 flex-shrink-0 text-[#39FF14]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>

          {/* New Playlist Row */}
          <div className="border-t border-white/10 p-2">
            {creating ? (
              <form onSubmit={handleCreate} className="flex gap-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Nama playlist…"
                  maxLength={200}
                  className="flex-1 min-w-0 text-xs bg-[#222226] text-white rounded-lg px-2.5 py-1.5 focus:outline-none border border-[#39FF14]/40 placeholder-[#8E8E93]"
                />
                <button
                  type="submit"
                  disabled={isBusy || !newName.trim()}
                  className="text-xs px-3 py-1.5 rounded-lg bg-[#39FF14] text-black font-bold disabled:opacity-40 hover:bg-[#57FF38] transition-default cursor-pointer"
                >
                  {isBusy ? "…" : "✓"}
                </button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs font-semibold text-[#8E8E93] hover:text-[#39FF14] hover:bg-white/5 transition-default cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                Playlist Baru
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
