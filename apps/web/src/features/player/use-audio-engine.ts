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
import { useMediaSession, buildArtwork, safeSetPositionState } from "./use-media-session";
import { parseTrackMeta } from "@/lib/track-meta";
import {
  isIosOrMobileWebKit,
  buildContinuousStreamUrl,
  mapContinuousTimeToTrack,
  generateContinuousSessionId,
} from "./continuous-player";

// ── Continuous stream mode (iOS/mobile WebKit only) ─────────────────────────
// On iOS Safari, changing audio.src while the screen is locked / app is
// backgrounded reliably stalls (WebKit bug 173332-style background socket
// suspension) even though audio.play() itself is called synchronously.
// repeat=one works because it never opens a new network resource — it just
// seeks the SAME already-buffered element back to 0.
//
// Fix: on iOS/mobile WebKit, drive playback through the backend's single
// continuous chunked stream (/api/audio/continuous) instead of swapping
// audio.src per track. audio.src is set ONCE per "session" (a run of tracks
// starting from a user-initiated action) and never changes again for natural
// forward progression — the server-side ffmpeg pipeline advances through the
// queue on its own, so there is no new network resource for iOS to suspend.
// See ./continuous-player.ts for the URL/time-mapping helpers.

// ── Client Stream Cache ───────────────────────────────────────────────────────
// In-memory cache for resolved stream URLs so track transitions (especially
// while the screen is locked) can happen synchronously without an async gap.

interface CachedStreamEntry {
  stream: AudioStream;
  fetchedAt: number;
}

const clientStreamCache = new Map<string, CachedStreamEntry>();
const inFlightStreamFetches = new Map<string, Promise<AudioStream>>();

/**
 * Returns the server-side proxy URL for a video stream.
 * Using the proxy instead of the raw CDN URL is essential for LAN/mobile clients:
 * YouTube CDN URLs contain an `ip=` parameter bound to the server's IP address.
 * Any client with a different IP (phone, other laptop on LAN) gets a 403 from the CDN.
 * The proxy endpoint (/api/audio/stream/:videoId) fetches from CDN server-side
 * so the correct IP is always used, then streams the bytes to any authenticated client.
 */
export function getProxyStreamUrl(videoId: string): string {
  return `/api/audio/stream/${encodeURIComponent(videoId)}`;
}

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

// ── Shuffle Helper ─────────────────────────────────────────────────────────────

export function shuffleArray<T>(items: T[], ensureDifferentFirst = false): T[] {
  if (items.length <= 1) return [...items];
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  if (ensureDifferentFirst && shuffled.length > 1 && shuffled[0] === items[0]) {
    const swapIdx = 1 + Math.floor(Math.random() * (shuffled.length - 1));
    [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
  }
  return shuffled;
}

// ── State reducer (for complex state transitions) ─────────────────────────────
// We use useReducer for the queue/shuffle/history to avoid stale closure bugs.

type QueueAction =
  | { type: "ADD";    track: PlayableTrack }
  | { type: "REMOVE"; index: number }
  | { type: "CLEAR" }
  | { type: "CLEAR_ALL" }
  | {
      type: "ADVANCE_NEXT";
      current: PlayableTrack | null;
      shuffleOn: boolean;
      repeatMode?: RepeatMode;
      chosenIndex?: number;
      nextTrack?: PlayableTrack | null;
      newQueue?: PlayableTrack[];
    }
  | { type: "ADVANCE_PREV"; current: PlayableTrack | null }
  | { type: "PUSH_HISTORY"; track: PlayableTrack }
  | { type: "SHUFFLE_TOGGLE" }
  | { type: "SET_SHUFFLE"; shuffleOn: boolean }
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

    case "CLEAR_ALL":
      return { ...state, queue: [], history: [], nextTrack: null };

    case "PUSH_HISTORY": {
      const history = [action.track, ...state.history].slice(0, HISTORY_MAX);
      return { ...state, history };
    }

    case "ADVANCE_NEXT": {
      // Deterministic path: if nextTrack and newQueue were already selected by advanceNext()
      if (action.newQueue !== undefined && action.nextTrack !== undefined) {
        const history = action.current
          ? (action.repeatMode === "all" && state.queue.length === 0
              ? []
              : [action.current, ...state.history].slice(0, HISTORY_MAX))
          : state.history;
        return {
          ...state,
          queue: action.newQueue,
          history,
          nextTrack: action.nextTrack,
        };
      }

      const { queue, shuffleOn } = state;
      if (queue.length === 0) {
        if (action.repeatMode === "all") {
          let full = action.current
            ? [...[...state.history].reverse(), action.current]
            : [...state.history].reverse();
          if (full.length > 0) {
            if (action.shuffleOn && full.length > 1) {
              full = shuffleArray(full, true);
            }
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
        return { ...state, shuffleOn: true, queue: shuffleArray(state.queue, true) };
      }
      return { ...state, shuffleOn: nextShuffle };
    }

    case "SET_SHUFFLE": {
      return { ...state, shuffleOn: action.shuffleOn };
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
        queue = shuffleArray(queue, true);
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

  // Continuous-mode state (iOS/mobile WebKit only — see block comment above).
  const continuousModeRef      = useRef(false);
  const continuousSessionIdRef = useRef<string | null>(null);
  // The exact ordered track list the currently-open continuous session was
  // built with (index 0 = whatever the session started on). Used to map
  // audio.currentTime (cumulative, never resets between tracks) back to
  // "which track is logically playing right now".
  const continuousQueueRef     = useRef<PlayableTrack[]>([]);
  const lastAdvanceTimeRef = useRef(0);
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
      if (queue.length > 2) candidates.push(queue[2]);
      if (repeatMode === "all") {
        const full = [...history].reverse();
        if (full.length > 0) candidates.push(full[0]);
      }
    }

    candidates.forEach((candidate, idx) => {
      if (candidate) {
        if (!getCachedStream(candidate.videoId)) {
          void fetchStreamWithCache(candidate.videoId)
            .then(() => {
              if (idx === 0 && typeof window !== "undefined") {
                fetch(getProxyStreamUrl(candidate.videoId), {
                  headers: { Range: "bytes=0-1024" },
                }).catch(() => {});
              }
            })
            .catch(() => {});
        } else if (idx === 0 && typeof window !== "undefined") {
          fetch(getProxyStreamUrl(candidate.videoId), {
            headers: { Range: "bytes=0-1024" },
          }).catch(() => {});
        }
      }
    });
  }, [currentTrack, queueState.queue, queueState.history, repeatMode, queueState.shuffleOn]);

  // ── Create the audio element once ─────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;

    const audio = new Audio();
    audio.preload = "auto";
    audio.setAttribute("playsinline", "");
    audio.setAttribute("webkit-playsinline", "");
    const saved = parseFloat(localStorage.getItem(VOLUME_KEY) ?? String(DEFAULT_VOLUME));
    audio.volume = isFinite(saved) && saved >= 0 && saved <= 1 ? saved : DEFAULT_VOLUME;

    // Attach to DOM so WebKit treats it as an active document media element,
    // preventing aggressive background tab suspension in iOS Safari
    if (typeof document !== "undefined" && document.body) {
      audio.style.position = "fixed";
      audio.style.width = "0px";
      audio.style.height = "0px";
      audio.style.opacity = "0";
      audio.style.pointerEvents = "none";
      audio.setAttribute("aria-hidden", "true");
      document.body.appendChild(audio);
    }

    audioRef.current = audio;

    return () => {
      isKeepAliveRef.current = false;
      audio.pause();
      audio.loop = false;
      audio.src = "";
      audio.load();
      if (audio.parentNode) {
        audio.parentNode.removeChild(audio);
      }
      audioRef.current = null;
    };
  }, []);

  // ── Core: resolve stream and play ─────────────────────────────────────────

  // Opens (or re-opens) a continuous chunked stream covering `orderedTracks`,
  // starting playback on orderedTracks[0]. Only ever called on iOS/mobile
  // WebKit. audio.src is set exactly once here — natural forward progression
  // afterwards is handled entirely client-side by the onTimeUpdate boundary
  // detector below (no further audio.src changes, no new network resource).
  const openContinuousSession = useCallback((orderedTracks: PlayableTrack[], startOffsetSeconds?: number): void => {
    if (orderedTracks.length === 0) return;
    const track = orderedTracks[0];
    const audio = audioRef.current;

    const sessionId = generateContinuousSessionId();
    continuousSessionIdRef.current = sessionId;
    continuousQueueRef.current     = orderedTracks;
    continuousModeRef.current      = true;

    currentTrackRef.current = track;
    setCurrentTrack(track);
    const initialDuration = track.durationSeconds || 0;
    setDuration(initialDuration);

    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        const meta = parseTrackMeta(track.title, track.channelName, initialDuration);
        navigator.mediaSession.metadata = new MediaMetadata({
          title:   meta.title,
          artist:  meta.artist,
          album:   meta.channelName || "Dengarkan",
          artwork: buildArtwork(track.thumbnailUrl),
        });
        navigator.mediaSession.playbackState = "playing";
        if (initialDuration > 0 && audio) {
          safeSetPositionState(audio, initialDuration, startOffsetSeconds || 0);
        }
      } catch { /* ignore */ }
    }

    if (!audio) return;

    isKeepAliveRef.current = false;
    // Looping/repeating is handled server-side for continuous sessions —
    // native audio.loop would restart the WHOLE chunked stream from byte 0.
    audio.loop = false;

    const url = buildContinuousStreamUrl(
      orderedTracks,
      0,
      undefined,
      sessionId,
      startOffsetSeconds,
      repeatModeRef.current
    );

    console.log(`[CONTINUOUS] Opening session ${sessionId} starting at: ${track.title}`);
    audio.src = url;
    setPlayerState("playing");
    try {
      const playPromise = audio.play();
      if (playPromise) void playPromise.catch((e) => {
        console.warn("Continuous stream play failed:", e);
      });
    } catch (e) {
      console.warn("Continuous stream play threw:", e);
    }
  }, []);

  // Synchronous direct track load: sets audio.src and initiates play in the exact same tick
  // to satisfy mobile browsers (Safari iOS lock screen background playback)
  const directLoadTrack = useCallback(async (track: PlayableTrack, overrideSequence?: PlayableTrack[], startOffsetSeconds?: number): Promise<void> => {
    // ── iOS/mobile WebKit: drive playback via the continuous stream instead ──
    // of swapping audio.src per track (see block comment near the top of file).
    if (isIosOrMobileWebKit()) {
      const rest = overrideSequence
        ? overrideSequence.filter((t) => t.videoId !== track.videoId)
        : queueStateRef.current.queue;
      openContinuousSession([track, ...rest], startOffsetSeconds);
      return;
    }

    currentTrackRef.current = track;
    setCurrentTrack(track);

    const cachedStream = getCachedStream(track.videoId);
    currentStreamRef.current = cachedStream || null;

    const initialDuration = track.durationSeconds || cachedStream?.durationSeconds || 0;
    setDuration(initialDuration);

    const audio = audioRef.current;

    // Sync MediaSession immediately in this synchronous tick so iOS Lock Screen updates instantly
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        const meta = parseTrackMeta(track.title, track.channelName, initialDuration);
        navigator.mediaSession.metadata = new MediaMetadata({
          title:   meta.title,
          artist:  meta.artist,
          album:   meta.channelName || "Dengarkan",
          artwork: buildArtwork(track.thumbnailUrl),
        });
        navigator.mediaSession.playbackState = "playing";
        if (initialDuration > 0 && audio) {
          safeSetPositionState(audio, initialDuration, 0);
        }
      } catch { /* ignore */ }
    }

    if (audio) {
      isKeepAliveRef.current = false;
      audio.loop = (repeatModeRef.current === "one");
      const targetSrc = getProxyStreamUrl(track.videoId);
      const isSameSrc = typeof window !== "undefined" && audio.src === new URL(targetSrc, window.location.href).href;

      if (!isSameSrc) {
        audio.src = targetSrc;
      }

      console.log(`[SONG CHANGED] Judul: ${track.title} | Artis: ${track.channelName || "Dengarkan"}`);
      console.log(`[MEDIA EVENT] PLAY | Time: ${audio.currentTime.toFixed(1)}s / ${initialDuration.toFixed(1)}s | Paused: false`);

      // ONLY set currentTime if an explicit positive seek offset was requested.
      // Setting currentTime = 0 on readyState === HAVE_NOTHING creates an unresolved
      // pending seek in WebKit AVFoundation that stalls background audio output!
      if (typeof startOffsetSeconds === "number" && startOffsetSeconds > 0) {
        try {
          audio.currentTime = startOffsetSeconds;
        } catch { /* ignore InvalidStateError in Safari */ }
      }

      setPlayerState("playing");
      try {
        const playPromise = audio.play();
        if (playPromise) {
          await playPromise;
        }
      } catch (e) {
        isAdvancingRef.current = false;
        console.warn("Audio play failed on direct load:", e);
      }
    }

    if (cachedStream) {
      setCurrentStream(cachedStream);
      if (cachedStream.durationSeconds && cachedStream.durationSeconds > 0) {
        setDuration(cachedStream.durationSeconds);
      }
    } else {
      void fetchStreamWithCache(track.videoId)
        .then((stream) => {
          if (currentTrackRef.current?.videoId === track.videoId) {
            currentStreamRef.current = stream;
            setCurrentStream(stream);
            if (stream.durationSeconds && stream.durationSeconds > 0) {
              setDuration(stream.durationSeconds);
            }
          }
        })
        .catch((err) => {
          console.warn("Background fetchStreamWithCache failed:", err);
        });
    }
  }, [fetchStreamWithCache, getCachedStream, openContinuousSession]);

  const loadTrack = useCallback(async (track: PlayableTrack) => {
    await directLoadTrack(track);
  }, [directLoadTrack]);

  // playTrack = loadTrack + optionally reset queue
  const playTrack = useCallback(async (track: PlayableTrack, resetQueue = false) => {
    if (resetQueue) {
      dispatchQueue({ type: "CLEAR" });
      await directLoadTrack(track, [track]);
    } else {
      if (currentTrackRef.current) {
        dispatchQueue({ type: "PUSH_HISTORY", track: currentTrackRef.current });
      }
      await directLoadTrack(track);
    }
  }, [directLoadTrack]);

  // playPlaylist: load a full playlist starting at a given index.
  const playPlaylist = useCallback(async (
    tracks: PlayableTrack[],
    startIndex: number = 0,
  ) => {
    if (tracks.length === 0) return;
    const idx     = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const current = tracks[idx];
    dispatchQueue({ type: "LOAD_PLAYLIST", tracks, startIndex: idx });

    await directLoadTrack(current);
  }, [directLoadTrack]);

  // ── Controls ──────────────────────────────────────────────────────────────

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      const playPromise = audio.play();
      if (playPromise) await playPromise;
    } catch (err) {
      console.error(err);
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !currentTrackRef.current) return;
    if (audio.paused) {
      try {
        const playPromise = audio.play();
        if (playPromise) await playPromise;
      } catch (err) {
        console.error(err);
      }
    } else {
      audio.pause();
    }
  }, []);

  const getCurrentTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !isFinite(audio.currentTime)) return 0;
    if (continuousModeRef.current) {
      const pos = mapContinuousTimeToTrack(continuousQueueRef.current, audio.currentTime, repeatModeRef.current);
      return pos?.trackTime ?? 0;
    }
    return audio.currentTime;
  }, []);

  const seek = useCallback(async (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !isFinite(seconds)) return;

    if (continuousModeRef.current) {
      // A live server-piped chunked stream can't be seeked in place — the
      // only way to land on an arbitrary offset is to reopen the session
      // starting at the current track with that offset. This is a
      // user-initiated, foreground action (dragging the seek bar), so a
      // fresh network resource here is fine — it's not the background
      // auto-advance case the continuous mode exists to protect.
      const track = currentTrackRef.current;
      if (!track) return;
      const dur = track.durationSeconds || 0;
      if (isFinite(dur) && dur > 0 && seconds >= dur - 0.5) {
        void advanceNextRef.current();
        return;
      }
      const target = Math.max(0, Math.min(seconds, isFinite(dur) ? dur : seconds));
      openContinuousSession([track, ...queueStateRef.current.queue], target);
      return;
    }

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
          const playPromise = audio.play();
          if (playPromise) await playPromise;
        }
      } catch (err) {
        console.warn("Failed to seek audio:", err);
      }
    }
  }, [openContinuousSession]);

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
    if (continuousModeRef.current && continuousSessionIdRef.current) {
      // Best-effort: tell the server to tear down the ffmpeg pipeline instead
      // of leaving it running until the client just drops the connection.
      void apiClient.audio.skipContinuous(continuousSessionIdRef.current, continuousQueueRef.current.length).catch(() => {});
    }
    continuousModeRef.current = false;
    continuousSessionIdRef.current = null;
    continuousQueueRef.current = [];
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.loop = false;
      audio.src = "";
    }
    setCurrentTrack(null);
    setCurrentStream(null);
    setPlayerState("idle");
    setDuration(0);
    dispatchQueue({ type: "CLEAR_ALL" });
    if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      } catch { /* ignore */ }
    }
  }, []);

  // ── Queue management ──────────────────────────────────────────────────────

  const addToQueue = useCallback((t: PlayableTrack) => {
    if (!currentTrackRef.current) {
      void playTrack(t);
    } else {
      dispatchQueue({ type: "ADD", track: t });
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
      } else {
        dispatchQueue({
          type: "SET_ALL_TRACKS",
          history: [],
          queue: filtered,
        });
      }
    }
  }, [clear]);

  // "Bersihkan" button cleans the ENTIRE list including the currently playing track
  const clearQueue = useCallback(() => {
    clear();
  }, [clear]);

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
    shuffleOnRef.current = nextShuffle;

    const { queue, history } = queueStateRef.current;
    if (nextShuffle) {
      const shuffledQueue = queue.length > 1 ? shuffleArray(queue, true) : [...queue];
      dispatchQueue({
        type: "SET_ALL_TRACKS",
        history,
        queue: shuffledQueue,
      });
      dispatchQueue({ type: "SET_SHUFFLE", shuffleOn: true });
    } else {
      dispatchQueue({ type: "SET_SHUFFLE", shuffleOn: false });
    }
  }, []);

  const setRepeatMode = useCallback((m: RepeatMode) => {
    setRepeatModeState(m);
    repeatModeRef.current = m;
    try { localStorage.setItem(REPEAT_KEY, m); } catch { /* ignore */ }

    if (continuousModeRef.current && continuousSessionIdRef.current) {
      // Continuous session: repeat is enforced server-side (ffmpeg loop /
      // wraparound), never via the native `loop` attribute.
      void apiClient.audio.setContinuousRepeat(continuousSessionIdRef.current, m).catch((e) => {
        console.warn("Failed to sync repeat mode to continuous session:", e);
      });
      return;
    }

    const audio = audioRef.current;
    if (audio) {
      audio.loop = (m === "one");
    }
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────────

  const advanceNext = useCallback(async () => {
    const now = Date.now();
    if (isAdvancingRef.current || now - lastAdvanceTimeRef.current < 2500) return;
    lastAdvanceTimeRef.current = now;
    isAdvancingRef.current = true;

    try {
      const audio     = audioRef.current;
      const current   = currentTrackRef.current;
      const repeat    = repeatModeRef.current;
      const shuffleOn = shuffleOnRef.current;
      const { queue, history } = queueStateRef.current;

      // 1. repeat=one → restart current track synchronously (works seamlessly on iOS lock screen)
      //    In continuous mode the server already handles repeat=one internally
      //    (it keeps re-streaming session.tracks[0] without advancing), so we
      //    must NOT manually seek audio.currentTime=0 here — that would seek
      //    the whole chunked stream's playhead, not just the current track.
      //    The onTimeUpdate boundary detector below reads the loop back to 0
      //    for UI purposes. This branch is only reached here if 'ended'/advanceNext
      //    got called anyway (e.g. as a manual mediaSession trigger) — treat it
      //    as a no-op in continuous mode and let the stream keep flowing.
      if (repeat === "one" && current) {
        if (continuousModeRef.current) return;
        if (audio) {
          audio.currentTime = 0;
          try {
            const playPromise = audio.play();
            if (playPromise) await playPromise;
          } catch (e) {
            console.error("Failed to replay track in repeat=one", e);
          }
        }
        return;
      }

      // 1b. Continuous mode manual/forced advance (mediaSession "next" button,
      // in-app skip button, or a fallback if 'ended' fires unexpectedly).
      // Natural forward progression is NOT handled here — it's detected
      // client-side by onTimeUpdate without ever calling advanceNext, so the
      // audio connection is never touched. This branch only runs for a
      // deliberate "jump ahead" — it asks the server to skip via a small POST
      // (no audio.src change, so it stands a much better chance of completing
      // even while the screen is locked than opening a new streamed resource).
      if (continuousModeRef.current && continuousSessionIdRef.current) {
        const sid = continuousSessionIdRef.current;
        const curTime = audio?.currentTime ?? 0;
        const posNow = mapContinuousTimeToTrack(continuousQueueRef.current, curTime, "none");
        const fromIdx = posNow?.trackIndex ?? 0;
        const targetIdx = fromIdx + 1;

        if (targetIdx < continuousQueueRef.current.length) {
          const nextTrack = continuousQueueRef.current[targetIdx];
          void apiClient.audio.skipContinuous(sid, targetIdx).catch((e) => {
            console.warn("Continuous skip request failed:", e);
          });

          dispatchQueue({
            type: "ADVANCE_NEXT",
            current,
            shuffleOn,
            repeatMode: repeat,
            chosenIndex: 0,
            nextTrack,
            newQueue: queue.slice(1),
          });

          currentTrackRef.current = nextTrack;
          setCurrentTrack(nextTrack);
          setDuration(nextTrack.durationSeconds || 0);
          if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
            try {
              const meta = parseTrackMeta(nextTrack.title, nextTrack.channelName, nextTrack.durationSeconds || 0);
              navigator.mediaSession.metadata = new MediaMetadata({
                title:   meta.title,
                artist:  meta.artist,
                album:   meta.channelName || "Dengarkan",
                artwork: buildArtwork(nextTrack.thumbnailUrl),
              });
            } catch { /* ignore */ }
          }
          return;
        }

        // Requested track isn't part of the currently open session (queue ran
        // out, or the app queue diverged from the session) — fall through to
        // opening a fresh session below, same as a discontinuous jump.
      }

      // 2. Normal queue advancement or shuffle from existing queue:
      if (queue.length > 0) {
        let chosenIdx = 0;
        if (shuffleOn && queue.length > 1) {
          chosenIdx = Math.floor(Math.random() * queue.length);
        }
        const nextTrack = queue[chosenIdx];
        const newQueue  = queue.filter((_, i) => i !== chosenIdx);

        dispatchQueue({
          type: "ADVANCE_NEXT",
          current,
          shuffleOn,
          repeatMode: repeat,
          chosenIndex: chosenIdx,
          nextTrack,
          newQueue,
        });

        await directLoadTrack(nextTrack);
        return;
      }

      // 3. Queue is empty: check repeat === "all"
      if (repeat === "all") {
        let full = current
          ? [...[...history].reverse(), current]
          : [...history].reverse();

        if (full.length > 0) {
          if (shuffleOn && full.length > 1) {
            full = shuffleArray(full, true);
          }
          const nextTrack = { ...full[0] };
          const newQueue  = full.slice(1);

          dispatchQueue({
            type: "ADVANCE_NEXT",
            current,
            shuffleOn,
            repeatMode: repeat,
            chosenIndex: 0,
            nextTrack,
            newQueue,
          });

          // If repeating the same track, seek to 0 and play directly (like repeat=one!)
          if (nextTrack.videoId === current?.videoId) {
            if (audio) {
              audio.currentTime = 0;
              try {
                const playPromise = audio.play();
                if (playPromise) await playPromise;
              } catch (e) {
                console.error("Failed to replay track in repeat=all", e);
              }
            }
            return;
          }

          await directLoadTrack(nextTrack);
          return;
        }
      }

      // 4. End of queue: stop playback and go idle
      dispatchQueue({ type: "ADVANCE_NEXT", current, shuffleOn, repeatMode: repeat });
      if (audio) {
        audio.pause();
        audio.src = "";
      }
      setPlayerState("idle");
    } finally {
      // NOTE: Do not clear isAdvancingRef synchronously here.
      // Changing audio.src emits asynchronous internal 'pause' events in WebKit.
      // isAdvancingRef is cleared when 'onPlaying' or 'onError' fires for the new track.
      // As a fallback guard, reset after 10s timeout if neither fired.
      setTimeout(() => {
        isAdvancingRef.current = false;
      }, 10_000);
    }
  }, [directLoadTrack]);

  const advancePrev = useCallback(async () => {
    const audio = audioRef.current;
    // audio.currentTime is cumulative across the whole session in continuous
    // mode — map it back to "seconds into the CURRENT track" for the
    // restart-vs-go-back threshold below to mean the same thing it does
    // outside continuous mode.
    const cur = continuousModeRef.current
      ? (mapContinuousTimeToTrack(continuousQueueRef.current, audio?.currentTime ?? 0, "none")?.trackTime ?? 0)
      : getCurrentTime();

    // If >3s played, restart rather than go back
    if (cur > 3) {
      if (continuousModeRef.current) {
        // Can't rewind just the current track on a live chunked stream —
        // reopen a fresh session starting at the same track, from 0.
        const track = currentTrackRef.current;
        if (track) openContinuousSession([track, ...queueStateRef.current.queue]);
        return;
      }
      if (audio) {
        audio.currentTime = 0;
        try {
          const playPromise = audio.play();
          if (playPromise) await playPromise;
        } catch (e) {
          console.error("Failed to restart track", e);
        }
      }
      return;
    }

    const { history } = queueStateRef.current;
    if (history.length === 0) return;

    const prevTrack = history[0];
    const current = currentTrackRef.current;

    dispatchQueue({ type: "ADVANCE_PREV", current });
    await directLoadTrack(prevTrack);
  }, [directLoadTrack, getCurrentTime, openContinuousSession]);

  const playTrackAtIndex = useCallback(async (index: number) => {
    const all = allTracksRef.current;
    if (index < 0 || index >= all.length) return;

    const curIdx = currentTrackRef.current ? queueStateRef.current.history.length : -1;
    if (index === curIdx) {
      const audio = audioRef.current;
      if (audio && audio.paused) {
        try {
          const playPromise = audio.play();
          if (playPromise) await playPromise;
        } catch (err) {
          console.error(err);
        }
      }
      return;
    }

    const target = all[index];
    const newHistory = all.slice(0, index).reverse().slice(0, HISTORY_MAX);
    let newQueue = all.slice(index + 1);

    if (shuffleOnRef.current && newQueue.length > 1) {
      newQueue = shuffleArray(newQueue, true);
    }

    dispatchQueue({
      type: "SET_ALL_TRACKS",
      history: newHistory,
      queue: newQueue,
    });

    await directLoadTrack(target);
  }, [directLoadTrack]);

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
      setTimeout(() => {
        isAdvancingRef.current = false;
      }, 1000);
      if (isKeepAliveRef.current) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      console.log(`[MEDIA EVENT] PLAYING | Time: ${audio.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s | Paused: false`);
      setPlayerState("playing");
    };

    const onPause = () => {
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      console.log(`[MEDIA EVENT] PAUSE | Time: ${audio.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s | Paused: true`);
      if (isKeepAliveRef.current || isAdvancingRef.current) return;

      // In continuous mode, audio.currentTime is cumulative across the WHOLE
      // chunked stream (never resets between tracks), so comparing it against
      // a single track's duration here would misfire near the end of every
      // track in the session. onTimeUpdate's dedicated continuous-mode branch
      // owns end-of-track/end-of-session detection instead.
      if (continuousModeRef.current) return;

      // Safari/WebKit always fires 'pause' right before 'ended' at the end of the track.
      // (As verified in Mac Web Inspector on iOS: PAUSE at 246.7s / 246.7s right before ENDED).
      // If we set playerState to 'paused' here, MediaSession tells iOS lock screen that
      // the user paused, causing iOS to suspend the tab before 'ended' can load the next track!
      if (
        audio.ended ||
        (isFinite(dur) && dur > 0 && audio.currentTime >= dur - 0.8) ||
        (isFinite(audio.duration) && audio.duration > 0 && audio.currentTime >= audio.duration - 0.8)
      ) {
        return;
      }

      setPlayerState((prev) => (prev === "refreshing" ? prev : "paused"));
    };

    const onWaiting = () => {
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      console.log(`[MEDIA EVENT] WAITING | Time: ${audio.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s | Paused: false`);
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
      // Continuous mode: duration is tracked per logical track by the
      // onTimeUpdate boundary detector, not by the stream's own (chunked,
      // often unknown/Infinity) audio.duration.
      if (continuousModeRef.current) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    const onDurationChange = () => {
      if (isKeepAliveRef.current) return;
      if (continuousModeRef.current) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    // progress event fires as the browser buffers ahead
    const onProgress = () => { /* buffer bar could be drawn here — no state change needed */ };

    // ── Ended: auto-advance to next track ──────────────────────────────────

    const onEnded = () => {
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      console.log(`[MEDIA EVENT] ENDED | Time: ${audio.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s | Paused: true`);
      if (isKeepAliveRef.current) return;
      // The continuous chunked stream only fires 'ended' when the WHOLE
      // session's HTTP response finishes (repeat='none' reaching the last
      // track, or the connection was closed) — never on an internal track
      // boundary (those are handled by onTimeUpdate below without touching
      // audio at all). So by the time 'ended' fires here, the session is
      // genuinely over — clear continuous state and let advanceNext's normal
      // "queue is empty" branch put the player back to idle.
      if (continuousModeRef.current) {
        continuousModeRef.current = false;
        continuousSessionIdRef.current = null;
        continuousQueueRef.current = [];
      }
      void advanceNextRef.current();
    };

    const onTimeUpdate = () => {
      if (isKeepAliveRef.current || isAdvancingRef.current) return;
      const cur = audio.currentTime;

      // ── Continuous mode: detect crossing into the next logical track ────
      // audio.currentTime is cumulative across the whole session and never
      // resets between tracks, so we map it back to "which track is playing
      // right now" and sync local UI state (currentTrack, duration,
      // mediaSession, queue/history) purely client-side — no audio.src
      // change, no network call, so nothing here can be blocked by iOS
      // background restrictions.
      if (continuousModeRef.current) {
        const pos = mapContinuousTimeToTrack(continuousQueueRef.current, cur, repeatModeRef.current);
        if (!pos) return;

        if (pos.track.videoId !== currentTrackRef.current?.videoId) {
          const current = currentTrackRef.current;
          const { queue } = queueStateRef.current;

          console.log(`[CONTINUOUS] Track boundary crossed → ${pos.track.title}`);

          currentTrackRef.current = pos.track;
          setCurrentTrack(pos.track);
          setDuration(pos.trackDuration);

          dispatchQueue({
            type: "ADVANCE_NEXT",
            current,
            shuffleOn: shuffleOnRef.current,
            repeatMode: repeatModeRef.current,
            chosenIndex: 0,
            nextTrack: pos.track,
            newQueue: queue.length > 0 ? queue.slice(1) : queue,
          });

          if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
            try {
              const meta = parseTrackMeta(pos.track.title, pos.track.channelName, pos.trackDuration);
              navigator.mediaSession.metadata = new MediaMetadata({
                title:   meta.title,
                artist:  meta.artist,
                album:   meta.channelName || "Dengarkan",
                artwork: buildArtwork(pos.track.thumbnailUrl),
              });
              safeSetPositionState(audio, pos.trackDuration, pos.trackTime);
            } catch { /* ignore */ }
          }
        } else {
          // Same track — just keep the lock-screen position indicator honest.
          if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
            try { safeSetPositionState(audio, pos.trackDuration, pos.trackTime); } catch { /* ignore */ }
          }
        }
        return;
      }

      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonicalDur = getCanonicalDuration(meta, audio.duration);

      // Detect end of real audio content:
      // Track must have played for at least 5 seconds before end detection can fire.
      if (
        isFinite(canonicalDur) &&
        canonicalDur > 5 &&
        cur >= 5 &&
        cur >= canonicalDur - 0.5
      ) {
        console.log(`[MEDIA EVENT] REAL END REACHED: ${cur.toFixed(1)}s / ${canonicalDur.toFixed(1)}s (audio.duration: ${audio.duration.toFixed(1)}s)`);
        void advanceNextRef.current();
      }
    };

    // ── Error: stream refresh flow ────────────────────────────────────────

    const onError = async () => {
      isAdvancingRef.current = false;
      const track = currentTrackRef.current;
      if (!track)                  { setPlayerState("error"); return; }
      if (refreshingRef.current)   { return; } // already refreshing

      if (continuousModeRef.current) {
        // The per-track CDN-refresh dance below doesn't apply to a chunked
        // continuous stream — just reopen a fresh session at roughly the
        // same point in the current track and let it resolve on its own.
        const pos = mapContinuousTimeToTrack(continuousQueueRef.current, audio.currentTime, repeatModeRef.current);
        const offset = pos?.trackTime;
        continuousModeRef.current = false;
        setPlayerState("refreshing");
        openContinuousSession([track, ...queueStateRef.current.queue], offset && offset > 0 ? offset : undefined);
        return;
      }

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
          audio.src = getProxyStreamUrl(track.videoId);
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
  }, [openContinuousSession]); // Run once — all handlers read from refs, not state

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
    onSeek:     seek,
    getCurrentTime,
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
