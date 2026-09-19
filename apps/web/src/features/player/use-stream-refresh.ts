"use client";

// ============================================
// DENGARKAN — Stream Refresh Hook
//
// Handles stream expiration and error recovery on the client side.
//
// Triggers:
//   • HTMLAudioElement 'error' event (network error, 403, codec fail)
//   • Proactive pre-expiry timer (fires 60s before stream expires)
//
// Refresh flow:
//   1. Save currentTime + playing state
//   2. Set playerState → "refreshing"
//   3. POST /api/audio/refresh (force-evict cache + re-resolve via yt-dlp)
//   4. Set new src, seek to savedTime
//   5. Resume if was playing
//   6. On failure: exponential backoff → max 3 attempts → "error" state
//
// State preservation:
//   • currentTime restored after re-src (seek to savedTime)
//   • queue and history are NOT touched (managed by PlayerContext)
//   • playerState goes: playing → refreshing → playing (on success)
//
// Network recovery:
//   • Uses navigator.onLine to detect offline state
//   • Waits for 'online' event before attempting refresh
//   • Does NOT retry infinitely — gives up after maxAttempts
// ============================================

import { useCallback, useRef, useEffect } from "react";
import type { AudioStream, PlayerState } from "@dengarkan/shared";
import { apiClient } from "@/services/api-client";
import type { PlayableTrack } from "./context";

// Retry configuration
const MAX_REFRESH_ATTEMPTS  = 3;
const INITIAL_RETRY_DELAY   = 1_500; // ms
const MAX_RETRY_DELAY       = 10_000; // ms
/** Proactively refresh this many ms before stream expires */
const PRE_EXPIRY_BUFFER_MS  = 90_000; // 90 seconds

interface RefreshCallbacks {
  audioRef:         React.RefObject<HTMLAudioElement | null>;
  currentTrackRef:  React.RefObject<PlayableTrack | null>;
  setPlayerState:   (state: PlayerState) => void;
  setCurrentStream: (stream: AudioStream) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.min(ms, MAX_RETRY_DELAY)));
}

/** Wait for network recovery if currently offline */
function waitForOnline(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    const handler = () => { window.removeEventListener("online", handler); resolve(); };
    window.addEventListener("online", handler);
  });
}

/**
 * Core refresh logic — shared between the proactive pre-expiry refresh
 * and the reactive audio error handler.
 *
 * Returns true if refresh succeeded.
 */
async function attemptRefresh(
  videoId: string,
  callbacks: RefreshCallbacks,
): Promise<boolean> {
  const { audioRef, setPlayerState, setCurrentStream } = callbacks;
  const audio = audioRef.current;
  if (!audio) return false;

  // Save state before touching audio element
  const savedTime  = audio.currentTime;
  const wasPlaying = !audio.paused;

  setPlayerState("refreshing");

  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt++) {
    try {
      // Wait for network if offline
      await waitForOnline();

      const fresh = await apiClient.audio.refresh(videoId);
      setCurrentStream(fresh);

      // Restore the audio element
      audio.src         = fresh.streamUrl;
      audio.currentTime = savedTime;

      if (wasPlaying) {
        await audio.play();
        // playerState → "playing" is driven by the onPlaying event
      } else {
        setPlayerState("paused");
      }

      return true;
    } catch (err: unknown) {
      const apiErr = err as { statusCode?: number; error?: string };

      // 429 — rate limited: don't hammer the server
      if (apiErr?.statusCode === 429) {
        if (attempt < MAX_REFRESH_ATTEMPTS) {
          await sleep(INITIAL_RETRY_DELAY * 2 ** (attempt - 1) * 2);
        }
        continue;
      }

      // 404 / 422 — video gone or unavailable: no point retrying
      if (apiErr?.statusCode === 404 || apiErr?.statusCode === 422) {
        setPlayerState("error");
        return false;
      }

      // Network / 502 / 500 — may be transient
      if (attempt < MAX_REFRESH_ATTEMPTS) {
        await sleep(INITIAL_RETRY_DELAY * 2 ** (attempt - 1));
      }
    }
  }

  setPlayerState("error");
  return false;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseStreamRefreshOptions {
  audioRef:          React.RefObject<HTMLAudioElement | null>;
  currentTrackRef:   React.RefObject<PlayableTrack | null>;
  currentStream:     AudioStream | null;
  playerState:       PlayerState;
  setPlayerState:    (state: PlayerState) => void;
  setCurrentStream:  (stream: AudioStream) => void;
}

export function useStreamRefresh({
  audioRef,
  currentTrackRef,
  currentStream,
  playerState,
  setPlayerState,
  setCurrentStream,
}: UseStreamRefreshOptions) {
  const refreshingRef = useRef(false); // prevent concurrent refreshes

  const callbacks: RefreshCallbacks = {
    audioRef,
    currentTrackRef,
    setPlayerState,
    setCurrentStream,
  };

  // ── Reactive error handler ────────────────────────────────────────────────
  // Called by the <audio> onError event in PlayerProvider.

  const handleStreamError = useCallback(async () => {
    const track = currentTrackRef.current;
    const audio  = audioRef.current;
    if (!track || !audio)       { setPlayerState("error"); return; }
    if (refreshingRef.current)  { return; } // already refreshing

    refreshingRef.current = true;
    try {
      await attemptRefresh(track.videoId, callbacks);
    } finally {
      refreshingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Proactive pre-expiry refresh ──────────────────────────────────────────
  // Schedules a background refresh before the stream URL actually expires,
  // so there's no interruption to the listener.

  useEffect(() => {
    if (!currentStream || playerState === "idle" || playerState === "error") return;

    const msUntilExpiry = currentStream.expiresAt - Date.now();
    const msUntilRefresh = msUntilExpiry - PRE_EXPIRY_BUFFER_MS;

    // If stream already within buffer window, refresh immediately
    if (msUntilRefresh <= 0) {
      const track = currentTrackRef.current;
      if (track && !refreshingRef.current) {
        refreshingRef.current = true;
        void attemptRefresh(track.videoId, callbacks).finally(() => {
          refreshingRef.current = false;
        });
      }
      return;
    }

    // Otherwise schedule for (expiresAt - 90s)
    const timerId = setTimeout(() => {
      const track = currentTrackRef.current;
      if (!track || refreshingRef.current) return;
      refreshingRef.current = true;
      void attemptRefresh(track.videoId, callbacks).finally(() => {
        refreshingRef.current = false;
      });
    }, msUntilRefresh);

    return () => clearTimeout(timerId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStream?.videoId, currentStream?.expiresAt]);

  return { handleStreamError };
}
