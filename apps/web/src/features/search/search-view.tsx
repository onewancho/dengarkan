"use client";

// ============================================
// DENGARKAN — Search Feature: Search View
//
// Fast, lightweight YouTube search interface:
//   • Header: "Putar Musik & Podcast YouTube-mu tanpa batas"
//   • Touch-friendly search bar (>= 44px) with quick search chips
//   • Result cards with instant play and Add to Playlist
//   • Clean Black (#000000) & Neon Green (#39FF14) styling
// ============================================

import React, { useState, useEffect, useCallback } from "react";
import type { SearchResult } from "@dengarkan/shared";
import { apiClient } from "@/services/api-client";
import { usePlayer } from "@/features/player/context";
import { AddToPlaylistButton } from "@/features/playlists/add-to-playlist-button";
import { parseTrackMeta } from "@/lib/track-meta";

const HISTORY_STORAGE_KEY = "dengarkan_search_history";
const MAX_HISTORY_ITEMS = 10;

export function SearchView() {
  const [query,       setQuery]       = useState("");
  const [results,     setResults]     = useState<SearchResult[]>([]);
  const [isLoading,   setIsLoading]   = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [justAdded,   setJustAdded]   = useState<string | null>(null);
  const [error,       setError]       = useState<string | null>(null);
  const [history,     setHistory]     = useState<string[]>([]);

  const latestQueryRef = React.useRef("");
  const { currentTrack, isPlaying, playTrack, addToQueue, next, playerState } = usePlayer();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setHistory(parsed.slice(0, MAX_HISTORY_ITEMS));
        }
      }
    } catch {
      // ignore storage error
    }
  }, []);

  const saveToHistory = useCallback((term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      const filtered = prev.filter((item) => item.toLowerCase() !== trimmed.toLowerCase());
      const next = [trimmed, ...filtered].slice(0, MAX_HISTORY_ITEMS);
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage error
      }
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_STORAGE_KEY);
    } catch {
      // ignore storage error
    }
  }, []);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      latestQueryRef.current = "";
      setResults([]);
      setHasSearched(false);
      setError(null);
      return;
    }
    latestQueryRef.current = trimmed;
    setIsLoading(true);
    setHasSearched(true);
    setError(null);
    try {
      const res = await apiClient.youtube.search(trimmed);
      if (latestQueryRef.current === trimmed) {
        setResults(res.results ?? []);
        setError(null);
      }
    } catch {
      if (latestQueryRef.current === trimmed) {
        setResults([]);
        setError("Gagal mencari musik. Silakan coba beberapa saat lagi.");
      }
    } finally {
      if (latestQueryRef.current === trimmed) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!query.trim()) return;
    const timer = setTimeout(() => runSearch(query), 400);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const handlePlayTrack = (track: SearchResult) => {
    const q = query.trim() || latestQueryRef.current;
    if (q) {
      saveToHistory(q);
    }
    void playTrack(track);
  };

  const handleAddToQueue = (track: SearchResult) => {
    const q = query.trim() || latestQueryRef.current;
    if (q) {
      saveToHistory(q);
    }
    if (!currentTrack) {
      void playTrack(track);
    } else {
      addToQueue(track);
    }
    setJustAdded(track.videoId);
    setTimeout(() => setJustAdded(null), 1500);
  };

  const isInitialState = !hasSearched && !query.trim() && results.length === 0;

  return (
    <div
      className={`w-full flex-1 flex flex-col transition-all duration-300 ease-out ${
        isInitialState
          ? "justify-center items-center pb-[var(--tabbar-height)]"
          : "justify-start pt-4 pb-36"
      }`}
    >
      {/* Search Header & Input Group */}
      <div
        className={`w-full max-w-xl mx-auto transition-all duration-300 ease-out ${
          isInitialState ? "my-auto flex flex-col items-center" : "mb-4"
        }`}
      >
        {/* Header Banner (Centered) */}
        <div className={`text-center transition-all duration-300 ${isInitialState ? "mb-6" : "mb-4"}`}>
          <h1 className={`font-bold tracking-tight text-white leading-tight text-center transition-all duration-300 ${isInitialState ? "text-xl sm:text-2xl" : "text-lg sm:text-xl"}`}>
            Putar Musik & Podcast YouTube-mu tanpa batas
          </h1>
          <p className="text-xs sm:text-sm text-[#8E8E93] mt-2 font-medium text-center max-w-lg mx-auto leading-relaxed">
            Nikmati audio dengan kualitas terbaik langsung dari browsermu
          </p>
        </div>

        {/* Search Bar (Centered, thumb friendly, with form submission for mobile keyboards) */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            (document.activeElement as HTMLElement)?.blur();
            if (query.trim()) {
              saveToHistory(query);
              void runSearch(query);
            }
          }}
          className="relative mb-3.5 w-full"
        >
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-[#8E8E93]">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
          </div>
          <input
            id="search-input"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) { setResults([]); setHasSearched(false); setError(null); }
            }}
            placeholder="Cari lagu, podcast, kesukaanmu…"
            className="w-full pl-11 pr-11 py-3.5 rounded-2xl bg-[#161619] border border-white/10 text-sm text-white placeholder-[#8E8E93] focus:outline-none focus:border-[#39FF14] focus:ring-1 focus:ring-[#39FF14]/30 transition-default min-h-[48px]"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); setResults([]); setHasSearched(false); setError(null); }}
              className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-[#8E8E93] hover:text-white transition-default cursor-pointer"
              aria-label="Hapus teks pencarian"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </form>

        {/* Search History */}
        {!hasSearched && history.length > 0 && (
          <div className="w-full max-w-xl mx-auto">
            <div className="flex items-center justify-between mb-2.5 px-1">
              <span className="text-xs font-semibold text-[#8E8E93] flex items-center gap-1.5">
                <svg className="w-3.5 h-3.5 text-[#8E8E93]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Riwayat Pencarian
              </span>
              <button
                type="button"
                onClick={clearHistory}
                className="text-[11px] font-medium text-[#8E8E93] hover:text-[#FF3B30] active:text-[#FF3B30] transition-default cursor-pointer py-1 px-2 -mr-1"
              >
                Hapus
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {history.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => {
                    setQuery(term);
                    saveToHistory(term);
                    void runSearch(term);
                  }}
                  className="text-xs px-3 py-2 rounded-xl bg-[#161619] hover:bg-[#222226] active:bg-[#2c2c30] text-white/90 hover:text-[#39FF14] border border-white/5 hover:border-[#39FF14]/30 transition-default cursor-pointer min-h-[36px] flex items-center gap-1.5"
                >
                  <svg className="w-3 h-3 text-[#8E8E93] flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span className="truncate max-w-[200px]">{term}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Loading Skeleton */}
      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-2xl bg-[#121214] animate-pulse border border-white/5">
              <div className="w-12 h-12 rounded-xl bg-[#222226] flex-shrink-0" />
              <div className="flex-1 space-y-2 min-w-0">
                <div className="h-3.5 bg-[#222226] rounded-md w-3/4" />
                <div className="h-3 bg-[#222226] rounded-md w-1/2" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Results List */}
      {!isLoading && results.length > 0 && (
        <div className="space-y-1.5">
          {results.map((track) => {
            const isCurrent = currentTrack?.videoId === track.videoId;
            const isAdded   = justAdded === track.videoId;
            const meta      = parseTrackMeta(track.title, track.channelName, track.durationFormatted || track.durationSeconds);

            return (
              <div
                key={track.videoId}
                className={`group flex items-center justify-between gap-2 p-2.5 sm:p-3 rounded-2xl transition-default border ${
                  isCurrent
                    ? "bg-[#39FF14]/10 border-[#39FF14]/30"
                    : "bg-[#121214] hover:bg-[#18181B] border-white/5"
                }`}
              >
                {/* Play Button + Track Info */}
                <button
                  onClick={() => handlePlayTrack(track)}
                  className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer focus:outline-none"
                  aria-label={`Putar ${track.title}`}
                >
                  <div className="relative w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-[#222226] border border-white/10">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={track.thumbnailUrl}
                      alt=""
                      className="w-full h-full object-cover group-hover:scale-105 transition-default"
                    />
                    {isCurrent && isPlaying ? (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <div className="w-3.5 h-3.5 flex items-end gap-0.5">
                          <span className="w-0.5 h-3 bg-[#39FF14] animate-pulse" />
                          <span className="w-0.5 h-2 bg-[#39FF14] animate-pulse delay-75" />
                          <span className="w-0.5 h-3.5 bg-[#39FF14] animate-pulse delay-150" />
                        </div>
                      </div>
                    ) : (
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-default">
                        <svg className="w-5 h-5 text-[#39FF14] ml-0.5 fill-current" viewBox="0 0 24 24">
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <h4
                      className={`text-xs sm:text-sm font-semibold truncate leading-tight transition-default ${
                        isCurrent ? "text-[#39FF14]" : "text-white group-hover:text-[#39FF14]"
                      }`}
                    >
                      {meta.title}
                    </h4>
                    <p className="text-[11px] font-medium text-white/80 truncate mt-0.5">
                      {meta.artist}
                    </p>
                    <p className="text-[10px] text-[#8E8E93] truncate mt-0.5">
                      {meta.channelInfo}
                    </p>
                  </div>
                </button>

                {/* Actions: Add to Queue & Add to Playlist */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* Add to queue */}
                  <button
                    onClick={() => handleAddToQueue(track)}
                    className={`min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center border transition-default ${
                      isAdded
                        ? "bg-[#39FF14]/20 border-[#39FF14]/30 text-[#39FF14]"
                        : "bg-[#18181B] hover:bg-[#222226] border-white/5 text-[#8E8E93] hover:text-white"
                    }`}
                    aria-label={isAdded ? "Ditambahkan ke antrean" : "Tambah ke antrean"}
                    title="Tambah ke antrean"
                  >
                    {isAdded ? (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    )}
                  </button>

                  {/* Add to playlist */}
                  <div
                    onClickCapture={() => {
                      const q = query.trim() || latestQueryRef.current;
                      if (q) {
                        saveToHistory(q);
                      }
                    }}
                  >
                    <AddToPlaylistButton track={track} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Error State */}
      {!isLoading && error && (
        <div className="text-center py-14">
          <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-3 text-red-400">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-white">{error}</p>
          <button
            onClick={() => runSearch(query)}
            className="mt-3.5 px-4 py-2 text-xs font-semibold rounded-xl bg-[#222226] hover:bg-[#2c2c32] text-white border border-white/10 transition-default cursor-pointer min-h-[40px] inline-flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            Coba Lagi
          </button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && hasSearched && results.length === 0 && (
        <div className="text-center py-16">
          <div className="w-12 h-12 rounded-2xl bg-[#161619] border border-white/5 flex items-center justify-center mx-auto mb-3 text-[#8E8E93]">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-white">Tidak ada hasil ditemukan</p>
          <p className="text-xs text-[#8E8E93] mt-1">Coba gunakan kata kunci pencarian yang lain.</p>
        </div>
      )}
    </div>
  );
}
