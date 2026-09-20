"use client";

// ============================================
// DENGARKAN — Audio Player UI
//
// Dual Player Architecture:
//   1. Mini Player: Docked bottom bar with artwork, title, progress, play/pause, next.
//   2. Full Player: Full-screen modal sheet with large artwork, seek bar,
//      shuffle, previous, play/pause, next, repeat, and queue drawer.
//
// Shared Engine:
//   • Powered by single persistent HTMLAudioElement via usePlayer()
//   • Zero re-renders on timeupdate (requestAnimationFrame DOM sync)
//   • Palette: Black (#000000), White (#FFFFFF), Neon Green (#39FF14), Muted Gray (#8E8E93)
// ============================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "./context";
import { type RepeatMode, getCanonicalDuration } from "./use-audio-engine";
import { parseTrackMeta } from "@/lib/track-meta";

function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer() {
  const {
    currentTrack,
    playerState,
    isPlaying,
    duration,
    shuffleOn,
    repeatMode,
    queue,
    allTracks,
    currentIndex,
    audioRef,
    removeFromQueue,
    clearQueue,
    clear,
    toggle,
    seek,
    next,
    previous,
    toggleShuffle,
    setRepeatMode,
    playFromQueue,
    playTrackAtIndex,
    getCurrentTime,
  } = usePlayer();

  const [isExpanded, setIsExpanded] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [mounted, setMounted] = useState(false);

  // ── Swipe Left to Reveal 'X' Close Button on Mini Player ───────────────────
  const REVEAL_WIDTH = 80;
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isRevealed, setIsRevealed] = useState(false);
  const [isSwiping, setIsSwiping] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const isDragging = useRef(false);
  const hasMoved = useRef(false);
  const startOffset = useRef(0);

  // Reset swipe state whenever track changes
  useEffect(() => {
    setSwipeOffset(0);
    setIsRevealed(false);
    setIsSwiping(false);
    setIsClosing(false);
  }, [currentTrack?.videoId]);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      clear();
      setIsClosing(false);
      setSwipeOffset(0);
      setIsRevealed(false);
      setIsSwiping(false);
    }, 220);
  }, [clear]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, a, input")) return;
    dragStartX.current = e.clientX;
    dragStartY.current = e.clientY;
    startOffset.current = swipeOffset;
    hasMoved.current = false;
    isDragging.current = true;
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;

    const dx = e.clientX - dragStartX.current;
    const dy = e.clientY - dragStartY.current;

    if (!hasMoved.current) {
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
        if (Math.abs(dx) > Math.abs(dy)) {
          hasMoved.current = true;
          setIsSwiping(true);
          try {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          } catch {}
        } else {
          isDragging.current = false;
          return;
        }
      } else {
        return;
      }
    }

    let newOffset = startOffset.current + dx;

    // Resistance dragging right past 0
    if (newOffset > 10) {
      newOffset = 10 * Math.log10(1 + (newOffset - 10));
    }
    // Resistance dragging far left beyond reveal
    if (newOffset < -REVEAL_WIDTH) {
      const extra = -REVEAL_WIDTH - newOffset;
      newOffset = -REVEAL_WIDTH - Math.min(extra * 0.35, 60);
    }

    setSwipeOffset(newOffset);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setIsSwiping(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    if (!hasMoved.current) {
      // Tap without drag
      if (isRevealed) {
        setSwipeOffset(0);
        setIsRevealed(false);
      } else {
        setIsExpanded(true);
      }
      return;
    }

    // Swiped past dismiss threshold (> 140px)
    if (swipeOffset < -140) {
      handleClose();
      return;
    }

    // Swiped to reveal close button (> 35px)
    if (swipeOffset < -35) {
      setSwipeOffset(-REVEAL_WIDTH);
      setIsRevealed(true);
    } else {
      setSwipeOffset(0);
      setIsRevealed(false);
    }
  };

  const handlePointerCancel = () => {
    isDragging.current = false;
    setIsSwiping(false);
    hasMoved.current = false;
    setSwipeOffset(isRevealed ? -REVEAL_WIDTH : 0);
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  const seekBy = useCallback((offsetSeconds: number) => {
    const audio = audioRef.current;
    const cur = getCurrentTime ? getCurrentTime() : ((audio && isFinite(audio.currentTime)) ? audio.currentTime : 0);
    seek(cur + offsetSeconds);
  }, [seek, audioRef, getCurrentTime]);

  // Lock body scroll and handle Escape / Arrow keys when full player is open
  useEffect(() => {
    if (!isExpanded) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showQueue) setShowQueue(false);
        else setIsExpanded(false);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekBy(-5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekBy(5);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [isExpanded, showQueue, seekBy]);

  // DOM refs for zero-render progress sync
  const miniBarRef      = useRef<HTMLDivElement | null>(null);
  const fullScrubberRef = useRef<HTMLInputElement | null>(null);
  const fullCurTimeRef  = useRef<HTMLSpanElement | null>(null);
  const fullDurTimeRef  = useRef<HTMLSpanElement | null>(null);
  const dragging        = useRef(false);

  // ── RAF Loop: Sync both Mini and Full progress without React state updates ──
  useEffect(() => {
    let animId: number | null = null;

    function syncDOM() {
      const audio = audioRef.current;
      if (audio) {
        const cur = getCurrentTime ? getCurrentTime() : ((audio && isFinite(audio.currentTime)) ? audio.currentTime : 0);
        const metaDur = (currentTrack?.durationSeconds && currentTrack.durationSeconds > 0)
          ? currentTrack.durationSeconds
          : (duration || 0);
        const dur = getCanonicalDuration(metaDur, audio?.duration);
        const clampedCur = dur > 0 ? Math.min(cur, dur) : cur;
        const pct = dur > 0 ? (clampedCur / dur) * 100 : 0;

        // Mini progress bar width
        if (miniBarRef.current) {
          miniBarRef.current.style.width = `${pct}%`;
        }

        // Full player scrubber & timestamps (only update when user is not scrubbing)
        if (!dragging.current && fullScrubberRef.current) {
          fullScrubberRef.current.value = String(clampedCur);
          fullScrubberRef.current.max = String(dur > 0 ? dur : 100);
          fullScrubberRef.current.style.setProperty("--progress", `${pct}%`);
        }
        if (!dragging.current && fullCurTimeRef.current) {
          fullCurTimeRef.current.textContent = fmt(clampedCur);
        }
        if (fullDurTimeRef.current) {
          fullDurTimeRef.current.textContent = fmt(dur);
        }
      }
      animId = requestAnimationFrame(syncDOM);
    }

    if (isPlaying || playerState === "buffering") {
      animId = requestAnimationFrame(syncDOM);
    } else {
      // Sync once when paused
      syncDOM();
    }

    return () => {
      if (animId !== null) cancelAnimationFrame(animId);
    };
  }, [isPlaying, playerState, audioRef, duration, currentTrack?.durationSeconds]);

  if (!currentTrack) return null;

  const metaDur = (currentTrack.durationSeconds && currentTrack.durationSeconds > 0)
    ? currentTrack.durationSeconds
    : (isFinite(duration) && duration > 0 ? duration : 0);
  const effectiveDuration = getCanonicalDuration(metaDur, audioRef.current?.duration);

  const meta = parseTrackMeta(
    currentTrack.title,
    currentTrack.channelName,
    effectiveDuration
  );

  const isLoading   = playerState === "loading" || playerState === "refreshing";
  const isError     = playerState === "error";
  const isBuffering = playerState === "buffering";

  const cycleRepeat = () => {
    const order: RepeatMode[] = ["none", "all", "one"];
    const nextIdx = (order.indexOf(repeatMode) + 1) % order.length;
    setRepeatMode(order[nextIdx]!);
  };

  return (
    <>
      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 1. MINI PLAYER (Docked bottom bar above navigation)                */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      <div className="fixed bottom-[var(--tabbar-height)] left-0 right-0 z-30 pointer-events-none">
        <div className="pointer-events-auto max-w-2xl mx-auto px-2">
          {/* Swipeable Container */}
          <div className="relative rounded-2xl overflow-hidden shadow-2xl bg-black">
            {/* Background Red Close Action (revealed when swiped left) */}
            <div
              className={`absolute inset-y-0 right-0 w-20 flex items-center justify-center bg-gradient-to-l from-[#FF3B30] to-[#D70015] rounded-r-2xl z-0 transition-opacity duration-150 ${
                swipeOffset < 0 || isRevealed ? "opacity-100" : "opacity-0 pointer-events-none"
              }`}
            >
              <button
                id="mini-close-btn"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose();
                }}
                className="w-full h-full flex flex-col items-center justify-center gap-0.5 text-white hover:bg-black/10 active:scale-95 transition-transform cursor-pointer"
                aria-label="Tutup pemutar lagu"
                title="Tutup pemutar"
              >
                <div className="w-8 h-8 rounded-full bg-white/20 flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-white">
                  Tutup
                </span>
              </button>
            </div>

            {/* Sliding Foreground Mini Player Card */}
            <div
              tabIndex={0}
              role="region"
              aria-label="Mini Player (geser ke kiri untuk menutup)"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setIsExpanded(true);
                }
              }}
              style={{
                transform: `translateX(${isClosing ? "-100%" : `${swipeOffset}px`})`,
                transition: isSwiping ? "none" : "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease",
                opacity: isClosing ? 0 : 1,
                touchAction: "pan-y",
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerCancel}
              className="glass bg-[#121214] border border-white/10 rounded-2xl px-3.5 py-2.5 relative select-none cursor-pointer overflow-hidden z-10 focus:outline-none focus:ring-1 focus:ring-[#39FF14]/50"
            >
              {/* Top Progress Line (Neon Green) */}
              <div className="absolute top-0 left-0 right-0 h-[2.5px] bg-white/10 overflow-hidden">
                <div
                  ref={miniBarRef}
                  className="h-full bg-[#39FF14] transition-none"
                  style={{ width: "0%" }}
                />
              </div>

              <div className="flex items-center justify-between gap-3 max-w-2xl mx-auto">
                {/* Artwork & Track Info */}
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="relative w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-[#161619] border border-white/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={currentTrack.thumbnailUrl}
                      alt=""
                      className={`w-full h-full object-cover ${isPlaying ? "opacity-100" : "opacity-75"}`}
                    />
                    {isLoading && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <div className="w-4 h-4 border-2 border-[#39FF14] border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <h4 className="text-xs sm:text-sm font-semibold text-white truncate leading-tight">
                      {meta.title}
                    </h4>
                    <p className="text-[11px] font-medium text-[#39FF14] truncate mt-0.5">
                      {meta.artist}
                    </p>
                    <p className="text-[10px] text-[#8E8E93] truncate">
                      {meta.channelInfo}
                      {isBuffering && " · Memuat buffer…"}
                      {playerState === "refreshing" && " · Memperbarui stream…"}
                      {isError && " · Gagal memutar"}
                    </p>
                  </div>
                </div>

                {/* Quick Actions (Play/Pause & Next) */}
                <div
                  className="flex items-center gap-1 flex-shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Play/Pause */}
                  <button
                    id="mini-play-pause"
                    onClick={toggle}
                    disabled={isLoading}
                    className="w-10 h-10 rounded-full bg-[#39FF14] text-black hover:bg-[#57FF38] active:scale-95 flex items-center justify-center transition-default shadow-md disabled:opacity-50"
                    aria-label={isPlaying ? "Jeda lagu" : "Putar lagu"}
                  >
                    {isLoading ? (
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                    ) : isPlaying ? (
                      <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5 fill-current ml-0.5" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>

                  {/* Next */}
                  <button
                    id="mini-next"
                    onClick={next}
                    className="w-10 h-10 rounded-full flex items-center justify-center text-[#8E8E93] hover:text-white hover:bg-white/5 active:scale-95 transition-default"
                    aria-label="Lagu berikutnya"
                  >
                    <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 2. FULL PLAYER (Modal / Full-Screen Sheet)                          */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {mounted && isExpanded && createPortal(
        <div
          className="fixed inset-0 z-50 bg-[#000000] flex flex-col justify-between px-6 safe-top safe-bottom overflow-hidden animate-in fade-in slide-in-from-bottom-8 duration-200"
          role="dialog"
          aria-modal="true"
          aria-label="Full Player"
        >
          {/* Header Row: Collapse + Title + Queue Toggle */}
          <div className="flex items-center justify-between py-3 max-w-md mx-auto w-full">
            <button
              onClick={() => setIsExpanded(false)}
              className="w-11 h-11 rounded-full flex items-center justify-center text-[#8E8E93] hover:text-white hover:bg-white/10 transition-default"
              aria-label="Tutup pemutar penuh"
            >
              <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            <span className="text-xs font-semibold uppercase tracking-widest text-[#8E8E93]">
              Sedang Memutar
            </span>

            <button
              onClick={() => setShowQueue(!showQueue)}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-default ${
                showQueue ? "text-[#39FF14] bg-[#39FF14]/15" : "text-[#8E8E93] hover:text-white hover:bg-white/10"
              }`}
              aria-label="Daftar antrean lagu"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
          </div>

          {/* Large Artwork */}
          <div className="flex-1 flex flex-col items-center justify-center py-4 max-w-md mx-auto w-full">
            <div className="relative w-full max-w-[320px] aspect-square rounded-3xl overflow-hidden shadow-2xl bg-[#161619] border border-white/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={currentTrack.thumbnailUrl}
                alt=""
                className="w-full h-full object-cover"
              />
              {isLoading && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-10 h-10 border-3 border-[#39FF14] border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>

            {/* Track Info (Judul Lagu, Penyanyi, nama channel - durasi) */}
            <div className="w-full mt-6 text-center px-4">
              <h2 className="text-lg sm:text-xl font-bold text-white line-clamp-2 leading-snug">
                {meta.title}
              </h2>
              <p className="text-sm sm:text-base font-semibold text-[#39FF14] truncate mt-1">
                {meta.artist}
              </p>
              <p className="text-xs text-[#8E8E93] truncate mt-1">
                {meta.channelInfo}
              </p>
              {isError && (
                <p className="text-xs text-[#FF3B30] mt-2 font-medium">
                  Tidak dapat memutar audio. Mencoba memperbarui stream...
                </p>
              )}
            </div>
          </div>

          {/* Controls & Scrubber (Bottom Weighted for One-Hand Thumb Reach) */}
          <div className="max-w-md mx-auto w-full pb-4 sm:pb-8">
            {/* Scrubber Range */}
            <div className="px-2 mb-3">
              <input
                ref={fullScrubberRef}
                type="range"
                min={0}
                max={effectiveDuration || 100}
                defaultValue={0}
                step={0.5}
                onPointerDown={(e) => {
                  dragging.current = true;
                  try {
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  } catch {}
                }}
                onPointerUp={(e) => {
                  if (!dragging.current) return;
                  dragging.current = false;
                  try {
                    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
                  } catch {}
                  const val = Number(e.currentTarget.value);
                  seek(val);
                }}
                onPointerCancel={() => {
                  dragging.current = false;
                }}
                onInput={(e) => {
                  const val = Number(e.currentTarget.value);
                  if (fullCurTimeRef.current) {
                    fullCurTimeRef.current.textContent = fmt(val);
                  }
                  const maxVal = Number(e.currentTarget.max) || effectiveDuration || 100;
                  const pct = maxVal > 0 ? (val / maxVal) * 100 : 0;
                  e.currentTarget.style.setProperty("--progress", `${pct}%`);
                }}
                onChange={(e) => {
                  if (!dragging.current) {
                    const val = Number(e.currentTarget.value);
                    seek(val);
                  }
                }}
                className="w-full h-2 rounded-full appearance-none cursor-pointer bg-[#222226] accent-[#39FF14] focus:outline-none"
                aria-label="Seek musik"
              />
              {/* Timestamps & Quick Seek Buttons */}
              <div className="flex items-center justify-between text-xs text-[#8E8E93] tabular-nums mt-2 font-medium">
                <div className="flex items-center gap-1.5">
                  <span ref={fullCurTimeRef}>0:00</span>
                  <button
                    type="button"
                    onClick={() => seekBy(-10)}
                    className="px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 active:scale-95 text-[11px] font-semibold text-[#8E8E93] hover:text-[#39FF14] transition-default cursor-pointer"
                    aria-label="Mundur 10 detik"
                    title="Mundur 10 detik"
                  >
                    -10s
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => seekBy(10)}
                    className="px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 active:scale-95 text-[11px] font-semibold text-[#8E8E93] hover:text-[#39FF14] transition-default cursor-pointer"
                    aria-label="Maju 10 detik"
                    title="Maju 10 detik"
                  >
                    +10s
                  </button>
                  <span ref={fullDurTimeRef}>{fmt(effectiveDuration)}</span>
                </div>
              </div>
            </div>

            {/* Main Controls Row */}
            <div className="flex items-center justify-between px-2 mt-4">
              {/* Shuffle */}
              <button
                onClick={toggleShuffle}
                className={`w-11 h-11 rounded-full flex items-center justify-center transition-default ${
                  shuffleOn ? "text-[#39FF14] bg-[#39FF14]/15" : "text-[#8E8E93] hover:text-white"
                }`}
                aria-label={shuffleOn ? "Acak aktif" : "Acak nonaktif"}
                title="Acak"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
                  <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
                  <line x1="4" y1="4" x2="9" y2="9" />
                </svg>
              </button>

              {/* Previous */}
              <button
                onClick={previous}
                className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:scale-95 transition-default"
                aria-label="Lagu sebelumnya"
              >
                <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                  <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                </svg>
              </button>

              {/* Play / Pause (Large Neon Circle) */}
              <button
                id="full-play-pause"
                onClick={toggle}
                disabled={isLoading}
                className="w-18 h-18 rounded-full bg-[#39FF14] text-black hover:bg-[#57FF38] active:scale-95 flex items-center justify-center shadow-xl glow-brand transition-default disabled:opacity-50"
                aria-label={isPlaying ? "Jeda pemutaran" : "Mulai pemutaran"}
              >
                {isLoading ? (
                  <div className="w-6 h-6 border-3 border-black border-t-transparent rounded-full animate-spin" />
                ) : isPlaying ? (
                  <svg className="w-8 h-8 fill-current" viewBox="0 0 24 24">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg className="w-8 h-8 fill-current ml-1" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* Next */}
              <button
                onClick={next}
                className="w-12 h-12 rounded-full flex items-center justify-center text-white hover:bg-white/10 active:scale-95 transition-default"
                aria-label="Lagu berikutnya"
              >
                <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
              </button>

              {/* Repeat */}
              <button
                onClick={cycleRepeat}
                className={`w-11 h-11 rounded-full flex items-center justify-center transition-default ${
                  repeatMode !== "none" ? "text-[#39FF14] bg-[#39FF14]/15" : "text-[#8E8E93] hover:text-white"
                }`}
                aria-label={`Mode Ulang: ${repeatMode}`}
                title={`Ulang: ${repeatMode}`}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  {repeatMode === "one" ? (
                    <>
                      <path d="M17 1l4 4-4 4" />
                      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                      <path d="M7 23l-4-4 4-4" />
                      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                      <text x="9" y="14" fontSize="6" fill="currentColor" stroke="none" fontWeight="bold">1</text>
                    </>
                  ) : (
                    <>
                      <path d="M17 1l4 4-4 4" />
                      <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                      <path d="M7 23l-4-4 4-4" />
                      <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                    </>
                  )}
                </svg>
              </button>
            </div>
          </div>

          {/* Queue Drawer Modal (Overlay within Full Player) */}
          {showQueue && (
            <div className="absolute inset-x-0 bottom-0 top-16 bg-[#121214] rounded-t-3xl border-t border-white/10 z-20 flex flex-col p-5 shadow-2xl animate-in slide-in-from-bottom-6 duration-200 safe-bottom">
              <div className="flex items-center justify-between pb-4 border-b border-white/10">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-white">Antrean Pemutaran</h3>
                  <span className="text-xs text-[#39FF14] bg-[#39FF14]/10 px-2 py-0.5 rounded-full font-medium">
                    {allTracks.length} lagu
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {allTracks.length > 1 && (
                    <button
                      onClick={clearQueue}
                      className="text-xs text-[#FF3B30] hover:underline px-2 py-1"
                    >
                      Hapus semua
                    </button>
                  )}
                  <button
                    onClick={() => setShowQueue(false)}
                    className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white text-xs"
                    aria-label="Tutup antrean"
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto py-2 space-y-1 scrollbar-thin">
                {allTracks.length === 0 ? (
                  <div className="text-center py-16 text-[#8E8E93]">
                    <p className="text-sm">Antrean kosong</p>
                    <p className="text-xs mt-1 opacity-60">Tambahkan lagu dari daftar putar atau pencarian</p>
                  </div>
                ) : (
                  allTracks.map((item, idx) => {
                    const qMeta = parseTrackMeta(item.title, item.channelName, item.durationSeconds);
                    const isCurrent = idx === currentIndex;
                    const isPlayed = idx < currentIndex;
                    return (
                      <div
                        key={`${item.videoId}-${idx}`}
                        className={`flex items-center justify-between gap-3 p-2.5 rounded-xl transition-default cursor-pointer ${
                          isCurrent
                            ? "bg-[#39FF14]/15 border border-[#39FF14]/30"
                            : isPlayed
                            ? "bg-white/[0.02] hover:bg-white/10 opacity-70 hover:opacity-100"
                            : "bg-white/5 hover:bg-white/10"
                        }`}
                        onClick={() => playTrackAtIndex(idx)}
                      >
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <span className="flex-shrink-0 w-5 flex items-center justify-center">
                            {isCurrent && isPlaying ? (
                              <div className="w-3.5 h-3 flex items-end gap-0.5">
                                <span className="w-0.5 h-3 bg-[#39FF14] animate-pulse" />
                                <span className="w-0.5 h-1.5 bg-[#39FF14] animate-pulse delay-75" />
                                <span className="w-0.5 h-2 bg-[#39FF14] animate-pulse delay-150" />
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
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {isCurrent && (
                                <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-[#39FF14] text-black">
                                  Diputar
                                </span>
                              )}
                              <p
                                className={`text-xs font-semibold truncate ${
                                  isCurrent ? "text-[#39FF14]" : isPlayed ? "text-white/70" : "text-white"
                                }`}
                              >
                                {qMeta.title}
                              </p>
                            </div>
                            <p className={`text-[11px] font-medium truncate mt-0.5 ${isCurrent ? "text-white/90" : "text-[#8E8E93]"}`}>
                              {qMeta.artist}
                            </p>
                            <p className="text-[10px] text-[#8E8E93]/60 truncate">
                              {qMeta.channelInfo}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeFromQueue(idx);
                          }}
                          className="p-1.5 rounded-lg text-[#8E8E93] hover:text-[#FF3B30] hover:bg-white/5 transition-default"
                          aria-label="Hapus dari antrean"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
