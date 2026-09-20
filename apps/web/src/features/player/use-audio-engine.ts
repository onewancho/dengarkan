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
  useMemo,
} from "react";
import type { PlayerState, AudioStream, SearchResult, QueueTrack } from "@dengarkan/shared";
import { apiClient } from "@/services/api-client";
import { useMediaSession, buildArtwork } from "./use-media-session";
import { parseTrackMeta } from "@/lib/track-meta";
import {
  isIosOrMobileWebKit,
  buildContinuousStreamUrl,
  getContinuousTrackOffset,
  mapContinuousTimeToTrack,
} from "./continuous-player";

// ── Client Stream Cache ───────────────────────────────────────────────────────
// In-memory cache for resolved stream URLs so track transitions (especially
// while the screen is locked) can happen synchronously without an async gap.

interface CachedStreamEntry {
  stream: AudioStream;
  fetchedAt: number;
}

const clientStreamCache = new Map<string, CachedStreamEntry>();
const inFlightStreamFetches = new Map<string, Promise<AudioStream>>();

export function getCachedStream(videoId: string): AudioStream | null {
  const entry = clientStreamCache.get(videoId);
  if (!entry) return null;
  const now = Date.now();
  if (entry.stream.expiresAt && entry.stream.expiresAt <= now + 60_000) {
    clientStreamCache.delete(videoId);
    return null;
  }
  return entry.stream;
}

export function setCachedStream(videoId: string, stream: AudioStream): void {
  clientStreamCache.set(videoId, { stream, fetchedAt: Date.now() });
  if (clientStreamCache.size > 50) {
    const oldestKey = clientStreamCache.keys().next().value;
    if (oldestKey) clientStreamCache.delete(oldestKey);
  }
}

export function clearStreamCache(): void {
  clientStreamCache.clear();
  inFlightStreamFetches.clear();
}

export async function fetchStreamWithCache(videoId: string): Promise<AudioStream> {
  const cached = getCachedStream(videoId);
  if (cached) return cached;

  const inFlight = inFlightStreamFetches.get(videoId);
  if (inFlight) return inFlight;

  const fetchPromise = (async () => {
    try {
      const stream = await apiClient.audio.resolve(videoId);
      setCachedStream(videoId, stream);
      return stream;
    } finally {
      inFlightStreamFetches.delete(videoId);
    }
  })();

  inFlightStreamFetches.set(videoId, fetchPromise);
  return fetchPromise;
}

export function getNextTrackCandidate(
  queue: PlayableTrack[],
  history: PlayableTrack[],
  current: PlayableTrack | null,
  repeatMode: RepeatMode,
  _shuffleOn?: boolean
): PlayableTrack | null {
  if (repeatMode === "one" && current) {
    return current;
  }
  if (queue.length > 0) {
    return queue[0];
  }
  if (repeatMode === "all") {
    const full = current
      ? [...[...history].reverse(), current]
      : [...history].reverse();
    return full[0] ?? null;
  }
  return null;
}

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
  allTracks:     PlayableTrack[];
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
  playTrackAtIndex:(index: number) => Promise<void>;
  pause:           () => void;
  play:            () => void;
  toggle:          () => void;
  seek:            (seconds: number) => void;
  getCurrentTime:  () => number;
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
const REPEAT_KEY      = "dengarkan:repeat";
const HISTORY_MAX     = 500;
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
  | { type: "REORDER"; fromIndex: number; toIndex: number }
  | { type: "SET_ALL_TRACKS"; history: PlayableTrack[]; queue: PlayableTrack[] };

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

      const idx = typeof action.chosenIndex === "number" && action.chosenIndex >= 0 && action.chosenIndex < queue.length
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

    case "SHUFFLE_TOGGLE": {
      const nextShuffle = !state.shuffleOn;
      if (nextShuffle && state.queue.length > 1) {
        const shuffled = [...state.queue];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return { ...state, shuffleOn: true, queue: shuffled };
      }
      return { ...state, shuffleOn: nextShuffle };
    }

    case "LOAD_PLAYLIST": {
      const { tracks, startIndex } = action;
      // tracks before startIndex become history (most recent = startIndex-1)
      const history = tracks
        .slice(0, startIndex)
        .reverse()
        .slice(0, HISTORY_MAX);
      // tracks after startIndex become the queue
      let queue = tracks.slice(startIndex + 1);
      if (state.shuffleOn && queue.length > 1) {
        queue = [...queue];
        for (let i = queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [queue[i], queue[j]] = [queue[j], queue[i]];
        }
      }
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

    case "SET_ALL_TRACKS":
      return { ...state, history: action.history, queue: action.queue, nextTrack: action.queue[0] ?? null };

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
  const isKeepAliveRef   = useRef(false);
  const lastAdvanceTimeRef = useRef(0);
  const advanceNextRef   = useRef<() => Promise<void>>(() => Promise.resolve());

  // Continuous stream refs for unbreakable iOS lock screen playback
  const continuousActiveRef    = useRef(false);
  const continuousTracksRef    = useRef<PlayableTrack[]>([]);
  const continuousOffsetRef    = useRef(0);
  const continuousSessionIdRef = useRef<string>("");

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

  // Unified full playlist/queue representation: [history (chronological) + currentTrack + queue]
  const allTracks = useMemo(() => {
    const list: PlayableTrack[] = [];
    if (queueState.history.length > 0) {
      list.push(...queueState.history.slice().reverse());
    }
    if (currentTrack) {
      list.push(currentTrack);
    }
    if (queueState.queue.length > 0) {
      list.push(...queueState.queue);
    }
    return list;
  }, [queueState.history, currentTrack, queueState.queue]);

  const allTracksRef = useRef<PlayableTrack[]>(allTracks);
  allTracksRef.current = allTracks;

  const currentIndex = currentTrack ? queueState.history.length : -1;

  // Auto-prefetch stream for the next tracks in queue/playlist while current track plays
  useEffect(() => {
    if (!currentTrack) return;
    const { queue, history } = queueState;
    const candidates: PlayableTrack[] = [];

    if (repeatMode === "one") {
      candidates.push(currentTrack);
    } else {
      if (queue.length > 0) candidates.push(queue[0]);
      if (queue.length > 1) candidates.push(queue[1]);
      if (candidates.length === 0 && repeatMode === "all") {
        const full = [...history].reverse();
        if (full.length > 0) candidates.push(full[0]);
      }
    }

    candidates.forEach((candidate) => {
      if (candidate && !getCachedStream(candidate.videoId)) {
        void fetchStreamWithCache(candidate.videoId).catch(() => {});
      }
    });
  }, [currentTrack, queueState.queue, queueState.history, repeatMode, queueState.shuffleOn]);

  // ── Create the audio element once ─────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;

    const audio = new Audio();
    audio.preload = "metadata";
    audio.setAttribute("playsinline", "");
    const saved = parseFloat(localStorage.getItem(VOLUME_KEY) ?? String(DEFAULT_VOLUME));
    audio.volume = isFinite(saved) && saved >= 0 && saved <= 1 ? saved : DEFAULT_VOLUME;
    audioRef.current = audio;

    return () => {
      isKeepAliveRef.current = false;
      audio.pause();
      audio.loop = false;
      audio.src = "";
      audio.load();
      audioRef.current = null;
    };
  }, []);

  // ── Core: resolve stream and play ─────────────────────────────────────────

  // ── Continuous Stream Mode (for iOS Lock Screen continuous playback) ────────

  const startContinuousStream = useCallback(async (
    tracks: PlayableTrack[],
    startIndex: number = 0,
    seekSeconds: number = 0
  ) => {
    if (tracks.length === 0) return;
    const idx = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const activeTrack = tracks[idx];
    const rep = repeatModeRef.current;
    let streamTracks = tracks.slice(idx);

    if (rep === "one") {
      streamTracks = [activeTrack];
    } else if (rep === "all") {
      const { history } = queueStateRef.current;
      const historyReversed = history.slice().reverse().filter((t) => t.videoId !== activeTrack.videoId);
      streamTracks = [activeTrack, ...streamTracks.slice(1), ...historyReversed];
    }

    const sid = `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    continuousSessionIdRef.current = sid;
    continuousActiveRef.current = true;
    continuousTracksRef.current = streamTracks;
    continuousOffsetRef.current = seekSeconds > 0 ? seekSeconds : 0;

    currentTrackRef.current = activeTrack;
    setCurrentTrack(activeTrack);
    setDuration(activeTrack.durationSeconds || 180);

    // Sync MediaSession immediately in this synchronous tick so iOS Lock Screen updates instantly
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        const meta = parseTrackMeta(activeTrack.title, activeTrack.channelName, activeTrack.durationSeconds);
        navigator.mediaSession.metadata = new MediaMetadata({
          title:   meta.title,
          artist:  meta.artist,
          album:   meta.channelName || "Dengarkan",
          artwork: buildArtwork(activeTrack.thumbnailUrl),
        });
        navigator.mediaSession.playbackState = "playing";
      } catch { /* ignore */ }
    }

    const audio = audioRef.current;
    if (!audio) return;

    const streamUrl = buildContinuousStreamUrl(streamTracks, 0, undefined, sid, seekSeconds, rep);
    isKeepAliveRef.current = false;
    audio.loop = false;
    audio.src = streamUrl;
    try {
      if (audio.readyState > 0 && audio.currentTime !== 0) {
        audio.currentTime = 0;
      }
    } catch { /* ignore InvalidStateError in Safari */ }

    setPlayerState("playing");
    try {
      await audio.play();
    } catch (e) {
      console.warn("Continuous audio.play() failed:", e);
    }
  }, []);

  // ── Core: resolve stream and play ─────────────────────────────────────────

  const loadTrack = useCallback(async (track: PlayableTrack) => {
    if (isIosOrMobileWebKit()) {
      let q = queueStateRef.current.queue;
      if (shuffleOnRef.current && q.length > 1) {
        q = [...q];
        for (let i = q.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [q[i], q[j]] = [q[j], q[i]];
        }
      }
      await startContinuousStream([track, ...q], 0);
      return;
    }

    setCurrentTrack(track);
    setDuration(track.durationSeconds || 0);

    const audio = audioRef.current;
    const cachedStream = getCachedStream(track.videoId);

    // Sync MediaSession immediately in this synchronous tick so iOS Lock Screen updates instantly
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        const meta = parseTrackMeta(track.title, track.channelName, track.durationSeconds);
        navigator.mediaSession.metadata = new MediaMetadata({
          title:   meta.title,
          artist:  meta.artist,
          album:   meta.channelName || "Dengarkan",
          artwork: buildArtwork(track.thumbnailUrl),
        });
        navigator.mediaSession.playbackState = "playing";
      } catch { /* ignore */ }
    }

    continuousActiveRef.current = false;
    if (cachedStream) {
      // FAST SYNCHRONOUS PATH: Stream is already resolved and cached in memory.
      // Setting src and calling play() in this tick satisfies mobile browser
      // requirement for continuous audio transitions when screen is locked.
      setCurrentStream(cachedStream);
      if (cachedStream.durationSeconds && cachedStream.durationSeconds > 0) {
        setDuration(cachedStream.durationSeconds);
      }
      if (audio) {
        isKeepAliveRef.current = false;
        audio.loop = false;
        audio.src = cachedStream.streamUrl;
        try {
          if (audio.readyState > 0 && audio.currentTime !== 0) {
            audio.currentTime = 0;
          }
        } catch { /* ignore InvalidStateError in Safari */ }
        setPlayerState("playing");
        try {
          await audio.play();
        } catch (e) {
          console.warn("Audio play failed on cached stream:", e);
        }
      }
      return;
    }

    // FALLBACK PATH: Stream not yet in cache.
    setPlayerState("loading");
    try {
      const stream = await fetchStreamWithCache(track.videoId);
      setCurrentStream(stream);
      if (stream.durationSeconds && stream.durationSeconds > 0) {
        setDuration(stream.durationSeconds);
      }

      if (!audio) return;
      isKeepAliveRef.current = false;
      audio.loop = false;
      audio.src = stream.streamUrl;
      try {
        if (audio.readyState > 0 && audio.currentTime !== 0) {
          audio.currentTime = 0;
        }
      } catch { /* ignore InvalidStateError in Safari */ }
      setPlayerState("playing");
      await audio.play();
    } catch {
      setPlayerState("error");
    }
  }, [startContinuousStream]);

  // playTrack = loadTrack + optionally reset queue
  const playTrack = useCallback(async (track: PlayableTrack, resetQueue = false) => {
    if (resetQueue) {
      dispatchQueue({ type: "CLEAR" });
    } else if (currentTrackRef.current) {
      dispatchQueue({ type: "PUSH_HISTORY", track: currentTrackRef.current });
    }

    if (isIosOrMobileWebKit()) {
      let remainingQueue = resetQueue ? [] : queueStateRef.current.queue;
      if (shuffleOnRef.current && remainingQueue.length > 1) {
        remainingQueue = [...remainingQueue];
        for (let i = remainingQueue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [remainingQueue[i], remainingQueue[j]] = [remainingQueue[j], remainingQueue[i]];
        }
      }
      await startContinuousStream([track, ...remainingQueue], 0);
    } else {
      await loadTrack(track);
    }
  }, [loadTrack, startContinuousStream]);

  // playPlaylist: load a full playlist starting at a given index.
  const playPlaylist = useCallback(async (
    tracks: PlayableTrack[],
    startIndex: number = 0,
  ) => {
    if (tracks.length === 0) return;
    const idx     = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const current = tracks[idx];
    // Set queue state first (synchronous)
    dispatchQueue({ type: "LOAD_PLAYLIST", tracks, startIndex: idx });

    let remaining = tracks.slice(idx + 1);
    if (shuffleOnRef.current && remaining.length > 1) {
      remaining = [...remaining];
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
    }

    if (isIosOrMobileWebKit()) {
      await startContinuousStream([current, ...remaining], 0);
    } else {
      await loadTrack(current);
    }
  }, [loadTrack, startContinuousStream]);

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

  const getCurrentTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !isFinite(audio.currentTime)) return 0;
    if (continuousActiveRef.current && continuousTracksRef.current.length > 0) {
      const totalTime = audio.currentTime + continuousOffsetRef.current;
      const mapped = mapContinuousTimeToTrack(continuousTracksRef.current, totalTime, repeatModeRef.current);
      return mapped ? mapped.trackTime : totalTime;
    }
    return audio.currentTime;
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
      if (continuousActiveRef.current) {
        const cur = currentTrackRef.current;
        const remainingQueue = queueStateRef.current.queue;
        const tracksToStream = cur ? [cur, ...remainingQueue] : continuousTracksRef.current;
        if (tracksToStream.length > 0) {
          // Reconnect continuous stream from target seek offset with instant low-latency FFmpeg -ss
          void startContinuousStream(tracksToStream, 0, target);
          return;
        }
      }

      try {
        audio.currentTime = target;
        if (playerStateRef.current === "playing" && audio.paused) {
          audio.play().catch((err) => console.warn("Failed to resume after seek:", err));
        }
      } catch (err) {
        console.warn("Failed to seek audio:", err);
      }
    }
  }, [startContinuousStream]);

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
    isKeepAliveRef.current = false;
    continuousActiveRef.current = false;
    continuousTracksRef.current = [];
    continuousOffsetRef.current = 0;
    continuousSessionIdRef.current = "";
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.loop = false; audio.src = ""; }
    setCurrentTrack(null);
    setCurrentStream(null);
    setPlayerState("idle");
    setDuration(0);
    dispatchQueue({ type: "CLEAR" });
  }, []);

  // ── Queue management ──────────────────────────────────────────────────────

  const addToQueue = useCallback((t: PlayableTrack) => {
    if (!currentTrackRef.current) {
      void playTrack(t);
    } else {
      dispatchQueue({ type: "ADD", track: t });
      if (continuousActiveRef.current) {
        continuousTracksRef.current = [...continuousTracksRef.current, t];
        if (continuousSessionIdRef.current) {
          void apiClient.audio.updateContinuousQueue(
            continuousSessionIdRef.current,
            continuousTracksRef.current
          ).catch(() => {});
        }
      }
    }
  }, [playTrack]);

  const removeFromQueue = useCallback((index: number) => {
    const all = allTracksRef.current;
    if (index < 0 || index >= all.length) return;

    const curIdx = currentTrackRef.current ? queueStateRef.current.history.length : -1;

    if (index === curIdx) {
      if (queueStateRef.current.queue.length > 0) {
        void advanceNextRef.current();
      } else if (queueStateRef.current.history.length > 0) {
        void advancePrevRef.current();
      } else {
        clear();
      }
    } else {
      const filtered = all.filter((_: PlayableTrack, i: number) => i !== index);
      const curId = currentTrackRef.current?.videoId;
      const newCurIdx = curId ? filtered.findIndex((t: PlayableTrack) => t.videoId === curId) : -1;
      if (newCurIdx !== -1) {
        const newHistory = filtered.slice(0, newCurIdx).reverse().slice(0, HISTORY_MAX);
        const newQueue = filtered.slice(newCurIdx + 1);
        dispatchQueue({
          type: "SET_ALL_TRACKS",
          history: newHistory,
          queue: newQueue,
        });
        if (continuousActiveRef.current && currentTrackRef.current) {
          continuousTracksRef.current = [currentTrackRef.current, ...newQueue];
          if (continuousSessionIdRef.current) {
            void apiClient.audio.updateContinuousQueue(
              continuousSessionIdRef.current,
              continuousTracksRef.current
            ).catch(() => {});
          }
        }
      } else {
        dispatchQueue({
          type: "SET_ALL_TRACKS",
          history: [],
          queue: filtered,
        });
      }
    }
  }, [clear]);

  const clearQueue = useCallback(() => {
    dispatchQueue({
      type: "SET_ALL_TRACKS",
      history: [],
      queue: [],
    });
    if (continuousActiveRef.current && currentTrackRef.current) {
      continuousTracksRef.current = [currentTrackRef.current];
      if (continuousSessionIdRef.current) {
        void apiClient.audio.updateContinuousQueue(
          continuousSessionIdRef.current,
          continuousTracksRef.current
        ).catch(() => {});
      }
    }
  }, []);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    const all = allTracksRef.current;
    if (fromIndex < 0 || fromIndex >= all.length || toIndex < 0 || toIndex >= all.length) return;
    if (fromIndex === toIndex) return;

    const reordered = [...all];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    const curId = currentTrackRef.current?.videoId;
    const newCurIdx = curId ? reordered.findIndex((t: PlayableTrack) => t.videoId === curId) : -1;

    if (newCurIdx !== -1) {
      const newHistory = reordered.slice(0, newCurIdx).reverse().slice(0, HISTORY_MAX);
      const newQueue = reordered.slice(newCurIdx + 1);
      dispatchQueue({
        type: "SET_ALL_TRACKS",
        history: newHistory,
        queue: newQueue,
      });
      if (continuousActiveRef.current && currentTrackRef.current) {
        continuousTracksRef.current = [currentTrackRef.current, ...newQueue];
        if (continuousSessionIdRef.current) {
          void apiClient.audio.updateContinuousQueue(
            continuousSessionIdRef.current,
            continuousTracksRef.current
          ).catch(() => {});
        }
      }
    } else {
      dispatchQueue({
        type: "SET_ALL_TRACKS",
        history: [],
        queue: reordered,
      });
    }
  }, []);

  const toggleShuffle = useCallback(() => {
    const nextShuffle = !shuffleOnRef.current;
    if (nextShuffle && queueStateRef.current.queue.length > 1) {
      const shuffled = [...queueStateRef.current.queue];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      dispatchQueue({
        type: "SET_ALL_TRACKS",
        history: queueStateRef.current.history,
        queue: shuffled,
      });
      if (continuousActiveRef.current && currentTrackRef.current) {
        continuousTracksRef.current = [currentTrackRef.current, ...shuffled];
        if (continuousSessionIdRef.current) {
          void apiClient.audio.updateContinuousQueue(
            continuousSessionIdRef.current,
            continuousTracksRef.current
          ).catch(() => {});
        }
      }
    }
    dispatchQueue({ type: "SHUFFLE_TOGGLE" });
  }, []);

  const setRepeatMode = useCallback((m: RepeatMode) => {
    setRepeatModeState(m);
    repeatModeRef.current = m;
    try { localStorage.setItem(REPEAT_KEY, m); } catch { /* ignore */ }
    if (continuousActiveRef.current && continuousSessionIdRef.current) {
      void apiClient.audio.setContinuousRepeat(continuousSessionIdRef.current, m).catch(() => {});
      const cur = currentTrackRef.current;
      const { queue, history } = queueStateRef.current;
      if (cur) {
        let tracks: PlayableTrack[] = [];
        if (m === "one") {
          tracks = [cur];
        } else if (m === "all") {
          const historyReversed = history.slice().reverse().filter((t) => t.videoId !== cur.videoId);
          tracks = [cur, ...queue, ...historyReversed];
        } else {
          tracks = [cur, ...queue];
        }
        continuousTracksRef.current = tracks;
        void apiClient.audio.updateContinuousQueue(continuousSessionIdRef.current, tracks).catch(() => {});
      }
    }
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────────

  const advanceNext = useCallback(async () => {
    const now = Date.now();
    if (isAdvancingRef.current || now - lastAdvanceTimeRef.current < 500) return;
    lastAdvanceTimeRef.current = now;
    isAdvancingRef.current = true;

    try {
      const current   = currentTrackRef.current;
      const repeat    = repeatModeRef.current;
      const shuffleOn = shuffleOnRef.current;

      // repeat=one → restart current track
      if (repeat === "one" && current) {
        if (continuousActiveRef.current) {
          await startContinuousStream([current, ...queueStateRef.current.queue], 0, 0);
        } else {
          const audio = audioRef.current;
          if (audio) {
            audio.currentTime = 0;
            try {
              await audio.play();
            } catch (e) {
              console.error("Failed to replay track in repeat=one", e);
            }
          }
        }
        return;
      }

      const { queue, history } = queueStateRef.current;

      if (continuousActiveRef.current) {
        if (queue.length > 0) {
          dispatchQueue({ type: "ADVANCE_NEXT", current, shuffleOn, repeatMode: repeat });
          await startContinuousStream(queue, 0);
          return;
        }
        if (repeat === "all") {
          const full = current
            ? [...[...history].reverse(), current]
            : [...history].reverse();
          if (full.length > 0) {
            dispatchQueue({ type: "ADVANCE_NEXT", current, shuffleOn, repeatMode: repeat, chosenIndex: 0 });
            await startContinuousStream(full, 0);
            return;
          }
        }
        continuousActiveRef.current = false;
        continuousTracksRef.current = [];
        continuousOffsetRef.current = 0;
        continuousSessionIdRef.current = "";
        const audio = audioRef.current;
        if (audio) { audio.pause(); audio.src = ""; }
        setPlayerState("idle");
        return;
      }

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
      isAdvancingRef.current = false;
    }
  }, [loadTrack, startContinuousStream]);

  const advancePrev = useCallback(async () => {
    const audio = audioRef.current;
    const cur = getCurrentTime();
    // If >3s played, restart rather than go back
    if (cur > 3) {
      if (continuousActiveRef.current) {
        seek(0);
        return;
      }
      if (audio) {
        audio.currentTime = 0;
        try {
          await audio.play();
        } catch (e) {
          console.error("Failed to restart track", e);
        }
      }
      return;
    }

    const { history, queue } = queueStateRef.current;
    if (history.length === 0) return;

    const prevTrack = history[0];
    const current = currentTrackRef.current;

    dispatchQueue({ type: "ADVANCE_PREV", current });
    if (continuousActiveRef.current) {
      const full = current ? [prevTrack, current, ...queue] : [prevTrack, ...queue];
      await startContinuousStream(full, 0);
    } else {
      await loadTrack(prevTrack);
    }
  }, [loadTrack, startContinuousStream, getCurrentTime, seek]);

  const playTrackAtIndex = useCallback(async (index: number) => {
    const all = allTracksRef.current;
    if (index < 0 || index >= all.length) return;

    const curIdx = currentTrackRef.current ? queueStateRef.current.history.length : -1;
    if (index === curIdx) {
      const audio = audioRef.current;
      if (audio && audio.paused) {
        audio.play().catch(console.error);
      }
      return;
    }

    const target = all[index];
    const newHistory = all.slice(0, index).reverse().slice(0, HISTORY_MAX);
    const newQueue = all.slice(index + 1);

    dispatchQueue({
      type: "SET_ALL_TRACKS",
      history: newHistory,
      queue: newQueue,
    });

    if (isIosOrMobileWebKit() || continuousActiveRef.current) {
      await startContinuousStream([target, ...newQueue], 0);
    } else {
      await loadTrack(target);
    }
  }, [loadTrack, startContinuousStream]);

  const playFromQueue = playTrackAtIndex;

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

    const onPlaying = () => {
      isAdvancingRef.current = false;
      if (isKeepAliveRef.current) return;
      setPlayerState("playing");
    };

    const onPause = () => {
      if (isKeepAliveRef.current || isAdvancingRef.current) return;
      setPlayerState((prev) => (prev === "refreshing" ? prev : "paused"));
    };

    const onWaiting = () => {
      if (isKeepAliveRef.current || isAdvancingRef.current) return;
      setPlayerState("buffering");
    };

    const onStalled = () => {
      if (isKeepAliveRef.current || isAdvancingRef.current) return;
      setPlayerState("buffering"); // network stall
    };

    const onCanPlay = () => {
      if (isKeepAliveRef.current) return;
      // Only transition from buffering → if audio is not paused
      if (!audio.paused) setPlayerState("playing");
    };

    const onLoadedMetadata = () => {
      if (isKeepAliveRef.current) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    const onDurationChange = () => {
      if (isKeepAliveRef.current) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    // progress event fires as the browser buffers ahead
    const onProgress = () => { /* buffer bar could be drawn here — no state change needed */ };

    // ── Ended: auto-advance to next track ──────────────────────────────────

    const onEnded = () => {
      if (isKeepAliveRef.current) return;
      if (continuousActiveRef.current) {
        continuousActiveRef.current = false;
        continuousTracksRef.current = [];
        continuousOffsetRef.current = 0;
        continuousSessionIdRef.current = "";
      }
      void advanceNextRef.current();
    };

    // ── TimeUpdate watchdog: fallback if browser doesn't fire ended event ─

    const onTimeUpdate = () => {
      if (isKeepAliveRef.current || isAdvancingRef.current) return;
      const cur = audio.currentTime;

      if (continuousActiveRef.current && continuousTracksRef.current.length > 0) {
        const totalTime = cur + continuousOffsetRef.current;
        const mapped = mapContinuousTimeToTrack(continuousTracksRef.current, totalTime, repeatModeRef.current);
        if (mapped && mapped.track.videoId !== currentTrackRef.current?.videoId) {
          const previousTrack = currentTrackRef.current;
          const newTrack = mapped.track;
          currentTrackRef.current = newTrack;
          setCurrentTrack(newTrack);
          setDuration(mapped.trackDuration);

          if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
            try {
              const meta = parseTrackMeta(newTrack.title, newTrack.channelName, newTrack.durationSeconds);
              navigator.mediaSession.metadata = new MediaMetadata({
                title:   meta.title,
                artist:  meta.artist,
                album:   meta.channelName || "Dengarkan",
                artwork: buildArtwork(newTrack.thumbnailUrl),
              });
              navigator.mediaSession.playbackState = "playing";
            } catch { /* ignore */ }
          }

          dispatchQueue({
            type: "ADVANCE_NEXT",
            current: previousTrack,
            shuffleOn: shuffleOnRef.current,
            repeatMode: repeatModeRef.current,
            chosenIndex: 0,
          });
          return;
        }
      }

      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      // Watchdog fallback if browser delays ended event (only for non-continuous stream)
      if (!continuousActiveRef.current && isFinite(dur) && dur > 0 && cur >= dur - 0.35) {
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
    allTracks,
    nextTrack:     queueState.queue[0] ?? null,
    previousTrack: queueState.history[0] ?? null,
    currentIndex,
    shuffleOn:     queueState.shuffleOn,
    repeatMode,
    isPlaying,
    // Actions
    audioRef,
    playTrack,
    playPlaylist,
    playFromQueue,
    playTrackAtIndex,
    loadTrack,
    play,
    pause,
    toggle,
    seek,
    getCurrentTime,
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
