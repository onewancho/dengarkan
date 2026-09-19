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
  type ReactNode,
} from "react";
import { useAudioEngine, type AudioEngine } from "./use-audio-engine";

// Re-export so other modules can import PlayableTrack / RepeatMode from here
export type { PlayableTrack, RepeatMode } from "./use-audio-engine";

const PlayerContext = createContext<AudioEngine | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const engine = useAudioEngine();

  return (
    <PlayerContext.Provider value={engine}>
      {children}
      {/* No <audio> JSX — the engine creates it imperatively in useEffect */}
    </PlayerContext.Provider>
  );
}

export function usePlayer(): AudioEngine {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
