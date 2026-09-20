"use client";

// ============================================
// DENGARKAN — Media Session Hook
// use-media-session.ts
//
// Implements the W3C Media Session API for iOS Lock Screen,
// Control Center, AirPods, and Bluetooth controls.
//
// ── What this enables ──────────────────────────────────────────────────────
//
//   • Lock Screen: track title, channel, artwork, scrubber, play/pause/skip
//   • Control Center: same controls as Lock Screen
//   • AirPods: play/pause (double/triple tap), skip (if supported)
//   • Bluetooth headphones: play/pause/skip buttons
//   • Carplay: play/pause/skip controls
//
// ── iOS Safari behavior (accurate as of iOS 17–18) ──────────────────────────
//
//   SUPPORTED (best-effort):
//   ✓ Background audio playback while Safari is backgrounded
//   ✓ Audio continues after Lock Screen (if playing before lock)
//   ✓ Lock Screen metadata: title, artist, artwork
//   ✓ Lock Screen play/pause button
//   ✓ Control Center now playing widget
//   ✓ AirPods play/pause (single tap / ear detection)
//   ✓ Next/previous track buttons (Lock Screen, AirPods)
//   ✓ Scrubber on Lock Screen (via setPositionState)
//   ✓ seekto, seekforward, seekbackward handlers
//
//   BEST-EFFORT (not guaranteed):
//   ~ Background tab may be suspended by iOS under memory pressure
//   ~ Low Power Mode may reduce background execution
//   ~ Playing via Bluetooth device may fail if audio route changes
//   ~ Audio session can be interrupted by phone calls, Siri, other apps
//
//   NOT SUPPORTED (iOS Safari limitations — do not attempt to work around):
//   ✗ Service Worker audio playback (Safari SW is not a media service worker)
//   ✗ Persistent background wake lock (iOS kills inactive background tabs)
//   ✗ Guaranteed background execution after long inactivity
//   ✗ audioSession.type — currently an Origin Trial / Chrome feature only
//
// ── Interruption handling ───────────────────────────────────────────────────
//
//   iOS pauses audio automatically during:
//   • Incoming phone calls
//   • Siri activation
//   • Other app taking audio focus
//
//   We handle the `pause` audio event from the engine (already registered in
//   use-audio-engine.ts). The audio element itself handles interruption
//   correctly — we do NOT need to add special interruption listeners.
//
//   On interruption end: iOS may auto-resume (depends on app audio category).
//   We listen for the `play` event on the audio element and sync playbackState.
//
// ── Performance contract ────────────────────────────────────────────────────
//
//   • No polling — all updates are event-driven
//   • playbackState synced on player state change (not on every frame)
//   • setPositionState called on timeupdate (throttled — max once per second)
//     and on seek, play, pause, and durationchange events
//   • artwork uses pre-known YouTube thumbnail URL patterns (no network calls)
//   • All API calls are wrapped in try/catch (Safari throws on unsupported actions)
//
// ============================================

import { useEffect, useRef } from "react";
import type { PlayerState } from "@dengarkan/shared";
import type { PlayableTrack } from "./use-audio-engine";
import { parseTrackMeta } from "@/lib/track-meta";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseMediaSessionOptions {
  audioRef:       React.RefObject<HTMLAudioElement | null>;
  currentTrack:   PlayableTrack | null;
  playerState:    PlayerState;
  duration:       number;
  onPlay:         () => void;
  onPause:        () => void;
  onNext:         () => void;
  onPrevious:     () => void;
  onSeek?:        (seconds: number) => void;
  getCurrentTime?:() => number;
}

// ── YouTube artwork size set ───────────────────────────────────────────────────
// YouTube thumbnails follow predictable URL patterns.
// We derive multiple sizes from the base URL for best Lock Screen rendering.

export function buildArtwork(thumbnailUrl: string): MediaImage[] {
  // If it's an i.ytimg.com URL, derive all size variants
  // Standard YouTube thumbnail sizes: mqdefault(320x180), hqdefault(480x360),
  // sddefault(640x480), maxresdefault(1280x720)
  if (thumbnailUrl.includes("i.ytimg.com/vi/")) {
    const base = thumbnailUrl.replace(/\/(hqdefault|mqdefault|sddefault|maxresdefault|default)(\.\w+)?$/, "");
    return [
      { src: `${base}/mqdefault.jpg`,     sizes: "320x180",  type: "image/jpeg" },
      { src: `${base}/hqdefault.jpg`,     sizes: "480x360",  type: "image/jpeg" },
      { src: `${base}/sddefault.jpg`,     sizes: "640x480",  type: "image/jpeg" },
      { src: `${base}/maxresdefault.jpg`, sizes: "1280x720", type: "image/jpeg" },
    ];
  }

  // Non-YouTube URL: single fallback entry
  return [
    { src: thumbnailUrl, sizes: "512x512", type: "image/jpeg" },
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeSetHandler(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Action not supported by this browser — safely ignored
  }
}

export function toPlaybackState(state: PlayerState, hasTrack: boolean): MediaSessionPlaybackState {
  if (!hasTrack || state === "idle") return "none";
  if (state === "playing" || state === "buffering") return "playing";
  // loading / refreshing preserve "playing" so iOS doesn't suspend during track transitions
  if (state === "loading" || state === "refreshing") return "playing";
  return "paused";
}

export function safeSetPositionState(
  audio: HTMLAudioElement | null,
  overrideDuration?: number,
  overridePosition?: number
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  if (!audio) return;

  const dur = (typeof overrideDuration === "number" && overrideDuration > 0)
    ? overrideDuration
    : audio.duration;
  const pos = (typeof overridePosition === "number" && overridePosition >= 0)
    ? overridePosition
    : audio.currentTime;

  // Validate all values before calling — invalid values throw on iOS
  if (
    !isFinite(dur) ||
    dur <= 0 ||
    !isFinite(pos) ||
    pos < 0
  ) return;

  const position = Math.min(pos, dur);
  try {
    navigator.mediaSession.setPositionState?.({
      duration:     dur,
      playbackRate: audio.playbackRate || 1.0,
      position,
    });
  } catch {
    // setPositionState is not universally supported
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useMediaSession({
  audioRef,
  currentTrack,
  playerState,
  duration,
  onPlay,
  onPause,
  onNext,
  onPrevious,
  onSeek,
  getCurrentTime,
}: UseMediaSessionOptions): void {
  const supported = typeof navigator !== "undefined" && "mediaSession" in navigator;

  // Throttle position updates — max once per second
  const lastPositionUpdate = useRef(0);

  // ── One-time setup: set audioSession type for iOS ──────────────────────────
  // navigator.audioSession.type = "playback" enables background playback
  // category on supported platforms. Currently a Chrome-origin-trial feature;
  // silently ignored on iOS Safari but we set it anyway for forward compat.

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    if ("audioSession" in navigator) {
      try {
        (navigator as unknown as { audioSession: { type: string } }).audioSession.type = "playback";
      } catch {
        // Not supported — safe to ignore
      }
    }
  }, []); // Once on mount

  // ── Metadata: update whenever track changes ────────────────────────────────

  useEffect(() => {
    if (!supported || !currentTrack) return;

    const meta = parseTrackMeta(currentTrack.title, currentTrack.channelName, currentTrack.durationSeconds);
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   meta.title,
      artist:  meta.artist,
      album:   meta.channelName || "Dengarkan",
      artwork: buildArtwork(currentTrack.thumbnailUrl),
    });
  }, [supported, currentTrack]);

  // ── playbackState: sync on every player state change ──────────────────────
  // This is what makes the Lock Screen play/pause button reflect correctly.
  // Must be event-driven — no polling.

  useEffect(() => {
    if (!supported) return;
    navigator.mediaSession.playbackState = toPlaybackState(playerState, Boolean(currentTrack));
  }, [supported, playerState, currentTrack]);

  // ── Action handlers: register once per track (stable audio element) ────────

  useEffect(() => {
    if (!supported || !currentTrack) return;

    const audio = audioRef.current;
    if (!audio) return;

    const SEEK_STEP = 10; // seconds for seekforward/seekbackward

    safeSetHandler("play",          () => { onPlay(); });
    safeSetHandler("pause",         () => { onPause(); });
    safeSetHandler("nexttrack",     () => { onNext(); });
    safeSetHandler("previoustrack", () => { onPrevious(); });

    safeSetHandler("seekbackward", (details) => {
      const offset = details?.seekOffset ?? SEEK_STEP;
      const cur = getCurrentTime ? getCurrentTime() : audio.currentTime;
      const target = Math.max(0, cur - offset);
      if (onSeek) {
        onSeek(target);
      } else {
        audio.currentTime = target;
      }
      safeSetPositionState(audio, duration, target);
    });

    safeSetHandler("seekforward", (details) => {
      const offset = details?.seekOffset ?? SEEK_STEP;
      const cur = getCurrentTime ? getCurrentTime() : audio.currentTime;
      const dur = duration > 0 ? duration : (isFinite(audio.duration) ? audio.duration : Infinity);
      const target = Math.min(dur, cur + offset);
      if (onSeek) {
        onSeek(target);
      } else {
        audio.currentTime = target;
      }
      safeSetPositionState(audio, duration, target);
    });

    safeSetHandler("seekto", (details) => {
      if (details?.seekTime == null || !isFinite(details.seekTime)) return;
      const dur = duration > 0 ? duration : (isFinite(audio.duration) ? audio.duration : Infinity);
      const target = Math.max(0, Math.min(details.seekTime, dur));
      if (onSeek) {
        onSeek(target);
      } else {
        audio.currentTime = target;
      }
      safeSetPositionState(audio, duration, target);
    });

    // Cleanup: null out all handlers when track changes or component unmounts
    return () => {
      (["play","pause","nexttrack","previoustrack","seekbackward","seekforward","seekto"] as const)
        .forEach(a => safeSetHandler(a, null));
    };
  // We intentionally include onPlay/onPause/onNext/onPrevious/onSeek as deps.
  // These are useCallback-wrapped in the engine so they're stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, currentTrack, duration, onSeek, getCurrentTime]);

  // ── Position state: event-driven, throttled ────────────────────────────────
  // Called on: play, pause, seeking, timeupdate (throttled), durationchange.
  // This powers the Lock Screen scrubber accurately without polling.

  useEffect(() => {
    if (!supported) return;
    const audio = audioRef.current;
    if (!audio) return;

    const updatePosition = () => {
      const now = Date.now();
      // Throttle to max once per second (timeupdate fires ~4x/s)
      if (now - lastPositionUpdate.current < 900) return;
      lastPositionUpdate.current = now;
      const pos = getCurrentTime ? getCurrentTime() : audio.currentTime;
      safeSetPositionState(audio, duration, pos);
    };

    const updatePositionImmediate = () => {
      // For seek/play/pause events — update immediately (no throttle)
      lastPositionUpdate.current = Date.now();
      const pos = getCurrentTime ? getCurrentTime() : audio.currentTime;
      safeSetPositionState(audio, duration, pos);
    };

    audio.addEventListener("timeupdate",     updatePosition);
    audio.addEventListener("play",           updatePositionImmediate);
    audio.addEventListener("pause",          updatePositionImmediate);
    audio.addEventListener("seeking",        updatePositionImmediate);
    audio.addEventListener("seeked",         updatePositionImmediate);
    audio.addEventListener("durationchange", updatePositionImmediate);
    audio.addEventListener("ratechange",     updatePositionImmediate);

    return () => {
      audio.removeEventListener("timeupdate",     updatePosition);
      audio.removeEventListener("play",           updatePositionImmediate);
      audio.removeEventListener("pause",          updatePositionImmediate);
      audio.removeEventListener("seeking",        updatePositionImmediate);
      audio.removeEventListener("seeked",         updatePositionImmediate);
      audio.removeEventListener("durationchange", updatePositionImmediate);
      audio.removeEventListener("ratechange",     updatePositionImmediate);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]); // Run once — reads audio element via ref

  // ── Clear metadata on unmount ──────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (!supported) return;
      try {
        navigator.mediaSession.metadata  = null;
        navigator.mediaSession.playbackState = "none";
      } catch { /* ignore */ }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
