"use client";

// ============================================
// DENGARKAN — Playlist Feature: Context
//
// Wraps usePlaylist so child components can
// consume playlist state without prop-drilling.
// ============================================

import React, { createContext, useContext, type ReactNode } from "react";
import { usePlaylist, type PlaylistState, type PlaylistActions } from "./use-playlist";

type PlaylistContextValue = PlaylistState & PlaylistActions;

const PlaylistContext = createContext<PlaylistContextValue | null>(null);

export function PlaylistProvider({ children }: { children: ReactNode }) {
  const value = usePlaylist();
  return (
    <PlaylistContext.Provider value={value}>
      {children}
    </PlaylistContext.Provider>
  );
}

export function usePlaylistContext(): PlaylistContextValue {
  const ctx = useContext(PlaylistContext);
  if (!ctx) throw new Error("usePlaylistContext must be used within PlaylistProvider");
  return ctx;
}
