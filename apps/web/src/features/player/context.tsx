"use client";

// ============================================
// DENGARKAN — Player Feature: Context
//
// Thin context wrapper around useAudioEngine.
// All logic lives in use-audio-engine.ts.
// ============================================

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAudioEngine, type AudioEngine, type PlayableTrack } from "./use-audio-engine";

// Re-export so other modules can import PlayableTrack / RepeatMode from here
export type { PlayableTrack, RepeatMode } from "./use-audio-engine";

// ── Play History (global, always-on) ─────────────────────────────────────────
// Moved here from history/page.tsx so history is captured even when the
// History page is not mounted (bug: song changes were missed while the user
// was on another page).
const HISTORY_STORAGE_KEY = "dengarkan:play_history";
const MAX_HISTORY = 100;

export interface PlayerContextValue extends AudioEngine {
  historyList: PlayableTrack[];
  clearHistory: () => void;
  removeHistory: (videoId: string) => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const engine = useAudioEngine();
  const [historyList, setHistoryList] = useState<PlayableTrack[]>([]);

  // 1. Initial load from localStorage (once, on provider mount)
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

  // 2. Automatically sync newly played track to history — lives at Provider
  // level so it keeps running regardless of which page is currently mounted.
  useEffect(() => {
    const track = engine.currentTrack;
    if (!track || !track.videoId) return;

    setHistoryList((prev) => {
      const filtered = prev.filter((t) => t.videoId !== track.videoId);
      const next = [track, ...filtered].slice(0, MAX_HISTORY);
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore localStorage quota error
      }
      return next;
    });
  }, [engine.currentTrack]);

  const clearHistory = () => {
    setHistoryList([]);
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify([]));
    } catch {}
  };

  const removeHistory = (videoId: string) => {
    setHistoryList((prev) => {
      const next = prev.filter((t) => t.videoId !== videoId);
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  const value: PlayerContextValue = {
    ...engine,
    historyList,
    clearHistory,
    removeHistory,
  };

  return (
    <PlayerContext.Provider value={value}>
      {children}
      {/* No <audio> JSX — the engine creates it imperatively in useEffect */}
    </PlayerContext.Provider>
  );
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
