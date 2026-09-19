"use client";

// ============================================
// DENGARKAN — Audio Engine Hook
//
// Owns the HTMLAudioElement and implements the full audio state machine.
//
// Architecture:
//   • Single HTMLAudioElement per mount (no duplicates)
//   • All state transitions are event-driven (no polling)
//   • currentTime is NOT in React state — read from audioRef directly
//   • Progress bar updates via requestAnimationFrame in audio-player.tsx
//   • Volume is persisted to localStorage
//   • Shuffle uses Fisher-Yates on a copy of the queue
//   • Repeat modes: none | one | all
//
// State machine:
//   idle        → loadTrack() → loading
//   loading     → onPlaying   → playing
//   loading     → onWaiting   → buffering (loading state, still loading)
//   playing     → onPause     → paused
//   playing     → onWaiting   → buffering
//   buffering   → onPlaying   → playing
//   playing     → onEnded     → idle (repeat=none) | loading (repeat=one/all)
//   *           → onError     → refreshing → playing (on success) | error
//   error       → loadTrack() → loading
//
// Memory:
//   • Audio element created once, reused for all tracks
//   • Old src replaced (browser GCs the previous blob)
//   • All event listeners removed on unmount
//   • No object URL leaks (stream URLs are CDN URLs, not blobs)
//
// Performance:
//   • No setState on timeupdate — UI reads audioRef.current.currentTime
//   • Volume change is a direct DOM write, no setState
//   • Shuffle does not trigger re-render of the queue during playback
//   • stalled event: only triggers buffering state, no polling
// ============================================

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useReducer,
} from "react";
import type { PlayerState, AudioStream, SearchResult, QueueTrack } from "@dengarkan/shared";
import { apiClient } from "@/services/api-client";
import { useMediaSession } from "./use-media-session";

/** A track that can be played — either a search result or a queue item */
export type PlayableTrack = SearchResult | QueueTrack;

/**
 * Safely resolves the canonical duration for a track.
 * YouTube streams often suffer from browser timescale decoding bugs (e.g. 2x duration on AAC-HE/DASH).
 * If a verified metadata duration is available, it is prioritized over erroneous browser audio.duration.
 */
export function getCanonicalDuration(metaDuration?: number, audioDuration?: number): number {
  const meta = isFinite(metaDuration as number) && (metaDuration as number) > 0 ? (metaDuration as number) : 0;
  const audio = isFinite(audioDuration as number) && (audioDuration as number) > 0 ? (audioDuration as number) : 0;

  if (meta > 0) {
    if (audio > 0 && Math.abs(audio - meta) / meta < 0.15) {
      return audio;
    }
    return meta;
  }
  return audio;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type RepeatMode = "none" | "one" | "all";

export interface AudioEngineState {
  currentTrack:  PlayableTrack | null;
  currentStream: AudioStream   | null;
  playerState:   PlayerState;
  duration:      number;
  volume:        number;         // 0–1
  isMuted:       boolean;
  queue:         PlayableTrack[];
  history:       PlayableTrack[];
  nextTrack:     PlayableTrack | null;
  previousTrack: PlayableTrack | null;
  currentIndex:  number;
  shuffleOn:     boolean;
  repeatMode:    RepeatMode;
  isPlaying:     boolean;
}

export interface AudioEngineActions {
  audioRef:        React.RefObject<HTMLAudioElement | null>;
  loadTrack:       (track: PlayableTrack) => Promise<void>;       // resolve + play
  playTrack:       (track: PlayableTrack, resetQueue?: boolean) => Promise<void>;
  playPlaylist:    (tracks: PlayableTrack[], startIndex?: number) => Promise<void>;
  playFromQueue:   (index: number) => Promise<void>;
  pause:           () => void;
  play:            () => void;
  toggle:          () => void;
  seek:            (seconds: number) => void;
  next:            () => void;
  previous:        () => void;
  setVolume:       (v: number) => void;
  toggleMute:      () => void;
  addToQueue:      (track: PlayableTrack) => void;
  removeFromQueue: (index: number) => void;
  clearQueue:      () => void;
  reorderQueue:    (fromIndex: number, toIndex: number) => void;
  toggleShuffle:   () => void;
  setRepeatMode:   (mode: RepeatMode) => void;
  clear:           () => void;
  setPlayerState:  (state: PlayerState) => void;
  setCurrentStream:(stream: AudioStream) => void;
}

export type AudioEngine = AudioEngineState & AudioEngineActions;

// ── Constants ─────────────────────────────────────────────────────────────────

const VOLUME_KEY      = "dengarkan:volume";
const HISTORY_MAX     = 30;
const DEFAULT_VOLUME  = 1.0;

// ── State reducer (for complex state transitions) ─────────────────────────────
// We use useReducer for the queue/shuffle/history to avoid stale closure bugs.

type QueueAction =
  | { type: "ADD";    track: PlayableTrack }
  | { type: "REMOVE"; index: number }
  | { type: "CLEAR" }
  | { type: "ADVANCE_NEXT"; current: PlayableTrack | null; shuffleOn: boolean; repeatMode?: RepeatMode; chosenIndex?: number }
  | { type: "ADVANCE_PREV"; current: PlayableTrack | null }
  | { type: "PUSH_HISTORY"; track: PlayableTrack }
  | { type: "SHUFFLE_TOGGLE" }
  // Load a playlist: sets queue to remaining tracks after startIndex.
  // The track at startIndex becomes currentTrack (handled by caller).
  | { type: "LOAD_PLAYLIST"; tracks: PlayableTrack[]; startIndex: number }
  | { type: "REORDER"; fromIndex: number; toIndex: number };

interface QueueState {
  queue:     PlayableTrack[];
  history:   PlayableTrack[];
  shuffleOn: boolean;
  // The "next track" determined by ADVANCE_NEXT (null = end of queue)
  nextTrack: PlayableTrack | null;
}

function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "ADD":
      return { ...state, queue: [...state.queue, action.track] };

    case "REMOVE":
      return { ...state, queue: state.queue.filter((_, i) => i !== action.index) };

    case "CLEAR":
      return { ...state, queue: [] };

    case "PUSH_HISTORY": {
      const history = [action.track, ...state.history].slice(0, HISTORY_MAX);
      return { ...state, history };
    }

    case "ADVANCE_NEXT": {
      const { queue, shuffleOn } = state;
      if (queue.length === 0) {
        if (action.repeatMode === "all") {
          const full = action.current
            ? [...[...state.history].reverse(), action.current]
            : [...state.history].reverse();
          if (full.length > 0) {
            const nextTrack = { ...full[0] };
            const newQueue  = full.slice(1);
            return { ...state, queue: newQueue, history: [], nextTrack };
          }
        }
        return { ...state, nextTrack: null };
      }

      let idx = typeof action.chosenIndex === "number" && action.chosenIndex >= 0 && action.chosenIndex < queue.length
        ? action.chosenIndex
        : (shuffleOn ? Math.floor(Math.random() * queue.length) : 0);

      const nextTrack = queue[idx];
      const newQueue  = queue.filter((_, i) => i !== idx);
      const history   = action.current
        ? [action.current, ...state.history].slice(0, HISTORY_MAX)
        : state.history;

      return { ...state, queue: newQueue, history, nextTrack };
    }

    case "ADVANCE_PREV": {
      if (state.history.length === 0) return { ...state, nextTrack: null };
      const [prev, ...rest] = state.history;
      const queue = action.current
        ? [action.current, ...state.queue]
        : state.queue;
      return { ...state, history: rest, queue, nextTrack: prev };
    }

    case "SHUFFLE_TOGGLE":
      return { ...state, shuffleOn: !state.shuffleOn };

    case "LOAD_PLAYLIST": {
      const { tracks, startIndex } = action;
      // tracks before startIndex become history (most recent = startIndex-1)
      const history = tracks
        .slice(0, startIndex)
        .reverse()
        .slice(0, HISTORY_MAX);
      // tracks after startIndex become the queue
      const queue = tracks.slice(startIndex + 1);
      return { ...state, queue, history, nextTrack: null };
    }

    case "REORDER": {
      const { fromIndex, toIndex } = action;
      const q = [...state.queue];
      if (fromIndex < 0 || fromIndex >= q.length || toIndex < 0 || toIndex >= q.length) return state;
      const [moved] = q.splice(fromIndex, 1);
      q.splice(toIndex, 0, moved);
      return { ...state, queue: q };
    }

    default:
      return state;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAudioEngine(): AudioEngine {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [currentTrack,  setCurrentTrack]  = useState<PlayableTrack | null>(null);
  const [currentStream, setCurrentStream] = useState<AudioStream   | null>(null);
  const [playerState,   setPlayerState]   = useState<PlayerState>("idle");
  const [duration,      setDuration]      = useState(0);
  const [volume,        setVolumeState]   = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_VOLUME;
    return parseFloat(localStorage.getItem(VOLUME_KEY) ?? String(DEFAULT_VOLUME));
  });
  const [isMuted,       setIsMuted]       = useState(false);
  const [repeatMode,    setRepeatModeState] = useState<RepeatMode>("none");

  const [queueState, dispatchQueue] = useReducer(queueReducer, {
    queue:     [],
    history:   [],
    shuffleOn: false,
    nextTrack: null,
  });

  // Stable refs for use inside event handlers (prevents stale closures)
  const currentTrackRef  = useRef<PlayableTrack | null>(null);
  const currentStreamRef = useRef<AudioStream   | null>(null);
  const playerStateRef   = useRef<PlayerState>("idle");
  const repeatModeRef    = useRef<RepeatMode>("none");
  const shuffleOnRef     = useRef(false);     // mirrors queueState.shuffleOn for event handlers
  const queueStateRef    = useRef(queueState);
  const refreshingRef    = useRef(false);
  const isAdvancingRef   = useRef(false);
  const advanceNextRef   = useRef<() => Promise<void>>(() => Promise.resolve());

  // Sync refs synchronously every render to prevent any stale closures
  currentTrackRef.current  = currentTrack;
  currentStreamRef.current = currentStream;
  playerStateRef.current   = playerState;
  repeatModeRef.current    = repeatMode;
  shuffleOnRef.current     = queueState.shuffleOn;
  queueStateRef.current    = queueState;

  useEffect(() => { currentTrackRef.current  = currentTrack;  }, [currentTrack]);
  useEffect(() => { currentStreamRef.current = currentStream; }, [currentStream]);
  useEffect(() => { playerStateRef.current   = playerState;   }, [playerState]);
  useEffect(() => { repeatModeRef.current    = repeatMode;    }, [repeatMode]);
  useEffect(() => { shuffleOnRef.current     = queueState.shuffleOn; }, [queueState.shuffleOn]);
  useEffect(() => { queueStateRef.current    = queueState;    }, [queueState]);

  // ── Create the audio element once ─────────────────────────────────────────

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    // playsInline is an HTML attribute; set via setAttribute for iOS
    audio.setAttribute("playsinline", "");
    audioRef.current = audio;

    // Restore volume from storage
    const saved = parseFloat(localStorage.getItem(VOLUME_KEY) ?? String(DEFAULT_VOLUME));
    audio.volume = isFinite(saved) && saved >= 0 && saved <= 1 ? saved : DEFAULT_VOLUME;

    return () => {
      audio.pause();
      audio.src = "";
      audio.load(); // release media resources
      audioRef.current = null;
    };
  }, []);

  // ── Core: resolve stream and play ─────────────────────────────────────────

  const loadTrack = useCallback(async (track: PlayableTrack) => {
    setCurrentTrack(track);
    setPlayerState("loading");
    setDuration(track.durationSeconds || 0);

    try {
      const stream = await apiClient.audio.resolve(track.videoId);
      setCurrentStream(stream);
      if (stream.durationSeconds && stream.durationSeconds > 0) {
        setDuration(stream.durationSeconds);
      }

      const audio = audioRef.current;
      if (!audio) return;
      audio.src = stream.streamUrl;
      audio.currentTime = 0;
      await audio.play();
    } catch {
      setPlayerState("error");
    }
  }, []);

  // playTrack = loadTrack + optionally reset queue
  const playTrack = useCallback(async (track: PlayableTrack, resetQueue = false) => {
    if (resetQueue) dispatchQueue({ type: "CLEAR" });
    await loadTrack(track);
  }, [loadTrack]);

  // playPlaylist: load a full playlist starting at a given index.
  // Atomically: sets the queue to tracks[startIndex+1..], history to tracks[0..startIndex-1],
  // then plays tracks[startIndex].
  // No audio is resolved for any track except the one being played.
  const playPlaylist = useCallback(async (
    tracks: PlayableTrack[],
    startIndex: number = 0,
  ) => {
    if (tracks.length === 0) return;
    const idx     = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const current = tracks[idx];
    // Set queue state first (synchronous)
    dispatchQueue({ type: "LOAD_PLAYLIST", tracks, startIndex: idx });
    // Then resolve and play the starting track
    await loadTrack(current);
  }, [loadTrack]);

  // ── Controls ──────────────────────────────────────────────────────────────

  const play = useCallback(() => {
    audioRef.current?.play().catch(console.error);
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrackRef.current) return;
    if (audio.paused) audio.play().catch(console.error);
    else              audio.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(seconds)) return;
    const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
    const dur = getCanonicalDuration(meta, audio.duration);

    // If seeking to or within 0.5s of the end (or past the end), advance to next track!
    if (isFinite(dur) && dur > 0 && seconds >= dur - 0.5) {
      void advanceNextRef.current();
      return;
    }

    const target = Math.max(0, Math.min(seconds, isFinite(dur) ? dur : seconds));
    if (isFinite(target)) {
      try {
        audio.currentTime = target;
        if (playerStateRef.current === "playing" && audio.paused) {
          audio.play().catch((err) => console.warn("Failed to resume after seek:", err));
        }
      } catch (err) {
        console.warn("Failed to seek audio:", err);
      }
    }
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    const audio   = audioRef.current;
    if (audio) audio.volume = clamped;
    setVolumeState(clamped);
    try { localStorage.setItem(VOLUME_KEY, String(clamped)); } catch { /* ignore */ }
    if (clamped > 0) setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.muted) {
      audio.muted = false;
      setIsMuted(false);
    } else {
      audio.muted = true;
      setIsMuted(true);
    }
  }, []);

  const clear = useCallback(() => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.src = ""; }
    setCurrentTrack(null);
    setCurrentStream(null);
    setPlayerState("idle");
    setDuration(0);
    dispatchQueue({ type: "CLEAR" });
  }, []);

  // ── Queue management ──────────────────────────────────────────────────────

  const addToQueue      = useCallback((t: PlayableTrack) => dispatchQueue({ type: "ADD",    track: t }), []);
  const removeFromQueue = useCallback((i: number)         => dispatchQueue({ type: "REMOVE", index: i }), []);
  const clearQueue      = useCallback(()                  => dispatchQueue({ type: "CLEAR" }),            []);
  const reorderQueue    = useCallback((from: number, to: number) => dispatchQueue({ type: "REORDER", fromIndex: from, toIndex: to }), []);
  const toggleShuffle   = useCallback(()                  => dispatchQueue({ type: "SHUFFLE_TOGGLE" }),  []);
  const setRepeatMode   = useCallback((m: RepeatMode) => setRepeatModeState(m), []);

  // ── Navigation ────────────────────────────────────────────────────────────

  const advanceNext = useCallback(async () => {
    if (isAdvancingRef.current) return;
    isAdvancingRef.current = true;

    try {
      const current   = currentTrackRef.current;
      const repeat    = repeatModeRef.current;
      const shuffleOn = shuffleOnRef.current;

      // repeat=one → restart current track
      if (repeat === "one" && current) {
        const audio = audioRef.current;
        if (audio) {
          audio.currentTime = 0;
          try {
            await audio.play();
          } catch (e) {
            console.error("Failed to replay track in repeat=one", e);
          }
        }
        return;
      }

      const { queue, history } = queueStateRef.current;

      if (queue.length === 0) {
        if (repeat === "all") {
          const full = current
            ? [...[...history].reverse(), current]
            : [...history].reverse();
          if (full.length > 0) {
            const nextTrack = { ...full[0] };
            dispatchQueue({ type: "ADVANCE_NEXT", current, shuffleOn, repeatMode: repeat, chosenIndex: 0 });
            await loadTrack(nextTrack);
            return;
          }
        }
        dispatchQueue({ type: "ADVANCE_NEXT", current, shuffleOn, repeatMode: repeat });
        setPlayerState("idle");
        return;
      }

      let idx = 0;
      if (shuffleOn) {
        idx = Math.floor(Math.random() * queue.length);
      }
      const nextTrack = queue[idx];

      dispatchQueue({ type: "ADVANCE_NEXT", current, shuffleOn, repeatMode: repeat, chosenIndex: idx });
      await loadTrack(nextTrack);
    } finally {
      setTimeout(() => {
        isAdvancingRef.current = false;
      }, 600);
    }
  }, [loadTrack]);

  const advancePrev = useCallback(async () => {
    const audio = audioRef.current;
    // If >3s played, restart rather than go back
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      try {
        await audio.play();
      } catch (e) {
        console.error("Failed to restart track", e);
      }
      return;
    }

    const { history } = queueStateRef.current;
    if (history.length === 0) return;

    const prevTrack = history[0];
    const current = currentTrackRef.current;

    dispatchQueue({ type: "ADVANCE_PREV", current });
    await loadTrack(prevTrack);
  }, [loadTrack]);

  const playFromQueue = useCallback(async (index: number) => {
    const { queue, history } = queueStateRef.current;
    if (index < 0 || index >= queue.length) return;
    const target = queue[index];
    const current = currentTrackRef.current;

    const newQueue = queue.slice(index + 1);
    const prevInQueue = queue.slice(0, index);
    const newHistory = current
      ? [current, ...prevInQueue.reverse(), ...history].slice(0, HISTORY_MAX)
      : [...prevInQueue.reverse(), ...history].slice(0, HISTORY_MAX);

    dispatchQueue({
      type: "LOAD_PLAYLIST",
      tracks: [...[...newHistory].reverse(), target, ...newQueue],
      startIndex: newHistory.length,
    });

    await loadTrack(target);
  }, [loadTrack]);

  const next = advanceNext;
  const previous = advancePrev;

  advanceNextRef.current = advanceNext;

  const advancePrevRef = useRef(advancePrev);
  advancePrevRef.current = advancePrev;

  // ── Audio element event listeners ─────────────────────────────────────────

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // ── State machine transitions ─────────────────────────────────────────

    const onPlaying = () => setPlayerState("playing");

    const onPause   = () => {
      // Ignore pause events during refreshing — the engine itself
      // caused the pause to swap src, not the user
      setPlayerState((prev) => prev === "refreshing" ? prev : "paused");
    };

    const onWaiting   = () => setPlayerState("buffering");
    const onStalled   = () => setPlayerState("buffering");  // network stall
    const onCanPlay   = () => {
      // Only transition from buffering → if audio is not paused
      if (!audio.paused) setPlayerState("playing");
    };

    const onLoadedMetadata = () => {
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    const onDurationChange = () => {
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    // progress event fires as the browser buffers ahead
    const onProgress = () => { /* buffer bar could be drawn here — no state change needed */ };

    // ── Ended: auto-advance to next track ──────────────────────────────────

    const onEnded = () => {
      void advanceNextRef.current();
    };

    // ── TimeUpdate watchdog: fallback if browser doesn't fire ended event ─

    const onTimeUpdate = () => {
      if (isAdvancingRef.current) return;
      const cur = audio.currentTime;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      if (isFinite(dur) && dur > 0 && cur >= dur - 0.35) {
        void advanceNextRef.current();
      }
    };

    // ── Error: stream refresh flow ────────────────────────────────────────

    const onError = async () => {
      const track = currentTrackRef.current;
      if (!track)                  { setPlayerState("error"); return; }
      if (refreshingRef.current)   { return; } // already refreshing

      const savedTime  = audio.currentTime;
      const wasPlaying = !audio.paused;

      setPlayerState("refreshing");
      refreshingRef.current = true;

      const MAX_ATTEMPTS = 3;
      const BASE_DELAY   = 1_500;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          // Wait for network if offline
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            await new Promise<void>((r) => {
              const h = () => { window.removeEventListener("online", h); r(); };
              window.addEventListener("online", h);
            });
          }

          const fresh = await apiClient.audio.refresh(track.videoId);
          setCurrentStream(fresh);
          audio.src = fresh.streamUrl;
          audio.currentTime = savedTime;

          if (wasPlaying) {
            await audio.play();
          } else {
            setPlayerState("paused");
          }
          refreshingRef.current = false;
          return; // success
        } catch (err: unknown) {
          const apiErr = err as { statusCode?: number };
          // 404/422 = video gone → no retry
          if (apiErr?.statusCode === 404 || apiErr?.statusCode === 422) break;
          // 429 = rate limit → longer backoff
          const delay = apiErr?.statusCode === 429
            ? BASE_DELAY * 4 * attempt
            : BASE_DELAY * 2 ** (attempt - 1);
          if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, delay));
        }
      }

      refreshingRef.current = false;
      setPlayerState("error");
    };

    // ── Register all listeners ────────────────────────────────────────────

    audio.addEventListener("playing",         onPlaying);
    audio.addEventListener("pause",           onPause);
    audio.addEventListener("waiting",         onWaiting);
    audio.addEventListener("stalled",         onStalled);
    audio.addEventListener("canplay",         onCanPlay);
    audio.addEventListener("loadedmetadata",  onLoadedMetadata);
    audio.addEventListener("durationchange",  onDurationChange);
    audio.addEventListener("progress",        onProgress);
    audio.addEventListener("timeupdate",      onTimeUpdate);
    audio.addEventListener("ended",           onEnded);
    audio.addEventListener("error",           onError);

    return () => {
      audio.removeEventListener("playing",        onPlaying);
      audio.removeEventListener("pause",          onPause);
      audio.removeEventListener("waiting",        onWaiting);
      audio.removeEventListener("stalled",        onStalled);
      audio.removeEventListener("canplay",        onCanPlay);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("progress",       onProgress);
      audio.removeEventListener("timeupdate",      onTimeUpdate);
      audio.removeEventListener("ended",          onEnded);
      audio.removeEventListener("error",          onError);
    };
  }, []); // Run once — all handlers read from refs, not state

  // ── Media Session (Lock Screen / AirPods / Bluetooth) ─────────────────────
  // Delegated to useMediaSession — see use-media-session.ts for full
  // documentation of iOS Safari supported/best-effort/unsupported behaviors.

  useMediaSession({
    audioRef,
    currentTrack,
    playerState,
    duration,
    onPlay:     play,
    onPause:    pause,
    onNext:     next,
    onPrevious: previous,
  });



  const isPlaying = playerState === "playing" || playerState === "buffering";

  return {
    // State
    currentTrack,
    currentStream,
    playerState,
    duration,
    volume,
    isMuted,
    queue:         queueState.queue,
    history:       queueState.history,
    nextTrack:     queueState.queue[0] ?? null,
    previousTrack: queueState.history[0] ?? null,
    currentIndex:  currentTrack ? queueState.history.length : -1,
    shuffleOn:     queueState.shuffleOn,
    repeatMode,
    isPlaying,
    // Actions
    audioRef,
    playTrack,
    playPlaylist,
    playFromQueue,
    loadTrack,
    play,
    pause,
    toggle,
    seek,
    next,
    previous,
    setVolume,
    toggleMute,
    addToQueue,
    removeFromQueue,
    clearQueue,
    reorderQueue,
    toggleShuffle,
    setRepeatMode,
    clear,
    setPlayerState,
    setCurrentStream,
  };
}
