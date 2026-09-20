"use client";

// ============================================
// DENGARKAN — /app/queue Page
// Full queue management: reorder, shuffle, repeat
// ============================================

import React, { useState, useRef, useCallback } from "react";
import { usePlayer } from "@/features/player/context";
import type { RepeatMode } from "@/features/player/context";
import { parseTrackMeta } from "@/lib/track-meta";

export default function QueuePage() {
  const {
    currentTrack,
    isPlaying,
    allTracks,
    currentIndex,
    shuffleOn,
    repeatMode,
    removeFromQueue,
    clearQueue,
    reorderQueue,
    toggleShuffle,
    setRepeatMode,
    playTrackAtIndex,
  } = usePlayer();

  // ── Drag-and-drop state (pointer events for mobile support) ────────────
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragItemRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = useCallback((idx: number, e: React.PointerEvent) => {
    e.preventDefault();
    dragItemRef.current = idx;
    setDragIndex(idx);
    setOverIndex(idx);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  }, []);

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (dragItemRef.current === null || !listRef.current) return;

    const items = listRef.current.querySelectorAll("[data-queue-item]");
    const y = e.clientY;

    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        setOverIndex(i);
        break;
      }
    }
  }, []);

  const handleDragEnd = useCallback((e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    const from = dragItemRef.current;
    const to = overIndex;

    if (from !== null && to !== null && from !== to) {
      reorderQueue(from, to);
    }

    dragItemRef.current = null;
    setDragIndex(null);
    setOverIndex(null);
  }, [overIndex, reorderQueue]);

  const cycleRepeat = () => {
    const order: RepeatMode[] = ["none", "all", "one"];
    const nextIdx = (order.indexOf(repeatMode) + 1) % order.length;
    setRepeatMode(order[nextIdx]!);
  };

  const repeatLabel = repeatMode === "one" ? "Ulangi Satu" : repeatMode === "all" ? "Ulangi Semua" : "Tidak Ulangi";

  return (
    <div className="w-full pt-4 pb-36">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#39FF14]/10 border border-[#39FF14]/20 text-[#39FF14] text-xs font-semibold mb-2">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
              {allTracks.length} lagu dalam antrean
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              Antrean Pemutaran
            </h1>
          </div>
        </div>

        {/* Playback Controls Row */}
        <div className="flex items-center gap-2 mt-3">
          {/* Shuffle Toggle */}
          <button
            onClick={toggleShuffle}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-default min-h-[40px] cursor-pointer ${
              shuffleOn
                ? "bg-[#39FF14]/15 text-[#39FF14] border border-[#39FF14]/30"
                : "bg-[#161619] text-[#8E8E93] hover:text-white border border-white/5 hover:border-white/10"
            }`}
            aria-label={shuffleOn ? "Acak aktif" : "Acak nonaktif"}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
              <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
              <line x1="4" y1="4" x2="9" y2="9" />
            </svg>
            Acak {shuffleOn ? "ON" : "OFF"}
          </button>

          {/* Repeat Toggle */}
          <button
            onClick={cycleRepeat}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-default min-h-[40px] cursor-pointer ${
              repeatMode !== "none"
                ? "bg-[#39FF14]/15 text-[#39FF14] border border-[#39FF14]/30"
                : "bg-[#161619] text-[#8E8E93] hover:text-white border border-white/5 hover:border-white/10"
            }`}
            aria-label={repeatLabel}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 1l4 4-4 4" />
              <path d="M3 11V9a4 4 0 0 1 4-4h14" />
              <path d="M7 23l-4-4 4-4" />
              <path d="M21 13v2a4 4 0 0 1-4 4H3" />
              {repeatMode === "one" && (
                <text x="9" y="14" fontSize="6" fill="currentColor" stroke="none" fontWeight="bold">1</text>
              )}
            </svg>
            {repeatLabel}
          </button>

          {/* Clear All (when any tracks exist) */}
          {allTracks.length > 0 && (
            <button
              onClick={clearQueue}
              className="ml-auto flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-semibold text-[#FF3B30] bg-[#FF3B30]/10 hover:bg-[#FF3B30]/20 border border-[#FF3B30]/20 transition-default min-h-[40px] cursor-pointer"
              aria-label="Bersihkan semua antrean"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Bersihkan
            </button>
          )}
        </div>
      </div>

      {/* ── Queue List ────────────────────────────────────────────────── */}
      {allTracks.length > 0 && (
        <p className="text-[10px] font-bold uppercase tracking-widest text-[#8E8E93] mb-2">
          Daftar Lagu · {allTracks.length} lagu
        </p>
      )}

      <div ref={listRef} className="space-y-1">
        {allTracks.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[#161619] border border-white/5 flex items-center justify-center">
              <svg className="w-7 h-7 text-[#8E8E93]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </div>
            <p className="text-sm text-[#8E8E93] font-medium">Antrean kosong</p>
            <p className="text-xs text-[#8E8E93]/60 mt-1.5">
              Cari dan tambahkan lagu dari tab <strong className="text-[#39FF14]">Cari</strong>
            </p>
          </div>
        ) : (
          allTracks.map((item, idx) => {
            const qMeta = parseTrackMeta(item.title, item.channelName, item.durationSeconds);
            const isCurrent = idx === currentIndex;
            const isPlayed = idx < currentIndex;
            const isDragged = dragIndex === idx;
            const isOver = overIndex === idx && dragIndex !== null && dragIndex !== idx;

            return (
              <div
                key={`${item.videoId}-${idx}`}
                data-queue-item
                className={`flex items-center gap-2 p-2.5 rounded-xl transition-all duration-150 ${
                  isCurrent
                    ? "bg-[#39FF14]/10 border border-[#39FF14]/30 shadow-md shadow-[#39FF14]/5"
                    : isDragged
                    ? "opacity-50 scale-[0.97] bg-[#39FF14]/10 border border-[#39FF14]/30"
                    : isOver
                    ? "bg-[#39FF14]/5 border border-[#39FF14]/20 translate-y-0.5"
                    : isPlayed
                    ? "bg-white/[0.02] hover:bg-white/10 opacity-70 hover:opacity-100 border border-transparent"
                    : "bg-white/5 hover:bg-white/10 border border-transparent"
                }`}
                onPointerMove={handleDragMove}
                onPointerUp={handleDragEnd}
              >
                {/* Drag Handle */}
                <button
                  className="flex-shrink-0 w-8 h-10 flex items-center justify-center text-[#8E8E93] hover:text-white cursor-grab active:cursor-grabbing touch-none select-none"
                  onPointerDown={(e) => handleDragStart(idx, e)}
                  aria-label="Geser untuk mengatur urutan"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
                    <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
                  </svg>
                </button>

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
                          : isPlayed
                          ? "text-[#8E8E93]/60"
                          : "text-[#8E8E93]"
                      }`}
                    >
                      {idx + 1}
                    </span>
                  )}
                </div>

                {/* Thumbnail */}
                <div className="relative w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-[#161619] border border-white/10">
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

                {/* Track Info — Clickable to play */}
                <button
                  className="min-w-0 flex-1 text-left cursor-pointer"
                  onClick={() => playTrackAtIndex(idx)}
                >
                  <div className="flex items-center gap-1.5">
                    {isCurrent && (
                      <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-[#39FF14] text-black">
                        Diputar
                      </span>
                    )}
                    <p
                      className={`text-xs font-semibold truncate leading-tight ${
                        isCurrent ? "text-[#39FF14]" : isPlayed ? "text-white/70" : "text-white"
                      }`}
                    >
                      {qMeta.title}
                    </p>
                  </div>
                  <p className={`text-[11px] font-medium truncate mt-0.5 ${isCurrent ? "text-white/90" : "text-[#8E8E93]"}`}>
                    {qMeta.artist}
                  </p>
                  <p className="text-[10px] text-[#8E8E93]/70 truncate">
                    {qMeta.channelInfo}
                  </p>
                </button>

                {/* Remove Button */}
                <button
                  onClick={() => removeFromQueue(idx)}
                  className="flex-shrink-0 p-1.5 rounded-lg text-[#8E8E93] hover:text-[#FF3B30] hover:bg-white/5 transition-default cursor-pointer"
                  aria-label="Hapus dari antrean"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
