"use client";

// ============================================
// DENGARKAN — Audio Engine Hook
//
// Dual-element ping-pong audio engine for seamless playback and uninterrupted
// auto-advance on iOS Safari Lock Screen, Android Chrome, and Desktop.
//
// Architecture (Ping-Pong Dual Audio Elements):
//   • Two HTMLAudioElement instances (audioA & audioB) mounted to the DOM.
//   • Only one element is active ("A" or "B"); the other stands by as a pre-buffer.
//   • Initial gesture unlocks BOTH elements simultaneously (active gets track 1,
//     standby gets SILENT_AUDIO_URI at volume 0 then pauses). This gives WebKit
//     autoplay permission to both elements for the entire session lifetime.
//   • Standby element pre-buffers the next track via /api/audio/stream/:videoId
//     while active element plays track 1.
//   • When track 1 ends, standby element is played immediately, active slot flips,
//     and the previous element pre-buffers track 3.
//   • Repeat One uses native activeAudio.loop = true (zero network requests,
//     100% reliable on iOS lock screen).
//   • audioRef.current always points to the active element, providing full
//     backward-compatibility for useMediaSession and UI components.
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
import { SILENT_AUDIO_URI } from "./silent-audio";

// ── Client Stream Cache ───────────────────────────────────────────────────────
// In-memory cache for resolved stream URLs so track transitions can happen
// synchronously without an async gap.

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
 * The proxy endpoint (/api/audio/stream/:videoId) fetches from CDN server-side
 * and streams HTTP 206 Partial Content range requests to clients.
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
  loadTrack:       (track: PlayableTrack) => Promise<void>;
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
  | { type: "LOAD_PLAYLIST"; tracks: PlayableTrack[]; startIndex: number }
  | { type: "REORDER"; fromIndex: number; toIndex: number }
  | { type: "SET_ALL_TRACKS"; history: PlayableTrack[]; queue: PlayableTrack[] };

interface QueueState {
  queue:     PlayableTrack[];
  history:   PlayableTrack[];
  shuffleOn: boolean;
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
      const history = tracks
        .slice(0, startIndex)
        .reverse()
        .slice(0, HISTORY_MAX);
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
  // Dual-audio ping-pong references
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  const activeAudioSlotRef = useRef<"A" | "B">("A");
  const audioRef = useRef<HTMLAudioElement | null>(null); // Public ref: always points to active audio element
  const standbyPreloadedTrackRef = useRef<{ videoId: string; url: string } | null>(null);
  const standbyUnlockedRef = useRef(false);
  const isAutoAdvancingRef = useRef(false);
  const isHandoffInProgressRef = useRef(false);
  const repeatCycleRef = useRef<PlayableTrack[] | null>(null);
  const masterPlaylistRef = useRef<PlayableTrack[]>([]);

  const [currentTrack,  setCurrentTrack]  = useState<PlayableTrack | null>(null);
  const [currentStream, setCurrentStream] = useState<AudioStream   | null>(null);
  const [playerState,   setPlayerState]   = useState<PlayerState>("idle");
  const [duration,      setDuration]      = useState(0);
  const [volume,        setVolumeState]   = useState<number>(() => {
    if (typeof window === "undefined") return DEFAULT_VOLUME;
    return parseFloat(localStorage.getItem(VOLUME_KEY) ?? String(DEFAULT_VOLUME));
  });
  const [isMuted,       setIsMuted]       = useState(false);
  const [repeatMode,    setRepeatModeState] = useState<RepeatMode>(() => {
    if (typeof window === "undefined") return "none";
    return (localStorage.getItem(REPEAT_KEY) as RepeatMode) || "none";
  });

  const [queueState, dispatchQueue] = useReducer(queueReducer, {
    queue:     [],
    history:   [],
    shuffleOn: false,
    nextTrack: null,
  });

  // Stable refs for use inside event handlers (prevents stale closures)
  const currentTrackRef    = useRef<PlayableTrack | null>(null);
  const currentStreamRef   = useRef<AudioStream   | null>(null);
  const playerStateRef     = useRef<PlayerState>("idle");
  const repeatModeRef      = useRef<RepeatMode>("none");
  const shuffleOnRef       = useRef(false);
  const queueStateRef      = useRef(queueState);
  const refreshingRef      = useRef(false);
  const isAdvancingRef     = useRef(false);
  const lastAdvanceTimeRef = useRef(0);
  const advanceNextRef     = useRef<() => Promise<void>>(() => Promise.resolve());
  const advancePrevRef     = useRef<() => Promise<void>>(() => Promise.resolve());

  // Sync refs synchronously every render
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

  // Unified full playlist/queue representation
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
  if (masterPlaylistRef.current.length === 0 && allTracks.length > 0) {
    masterPlaylistRef.current = allTracks;
  }

  const currentIndex = currentTrack ? queueState.history.length : -1;

  // ── Ping-Pong Element Helpers ─────────────────────────────────────────────

  const getActiveAudio = useCallback((): HTMLAudioElement | null => {
    return activeAudioSlotRef.current === "A" ? audioARef.current : audioBRef.current;
  }, []);

  const getStandbyAudio = useCallback((): HTMLAudioElement | null => {
    return activeAudioSlotRef.current === "A" ? audioBRef.current : audioARef.current;
  }, []);

  const switchActiveSlot = useCallback((): { oldActive: HTMLAudioElement | null; newActive: HTMLAudioElement | null } => {
    const oldActive = activeAudioSlotRef.current === "A" ? audioARef.current : audioBRef.current;
    activeAudioSlotRef.current = activeAudioSlotRef.current === "A" ? "B" : "A";
    const newActive = activeAudioSlotRef.current === "A" ? audioARef.current : audioBRef.current;
    audioRef.current = newActive;
    return { oldActive, newActive };
  }, []);

  /**
   * Initial user gesture unlock:
   * WebKit on iOS requires a user gesture to grant autoplay permission.
   * By calling standby.play() with an inaudible silent audio URI during any user
   * tap, the standby element becomes fully authorized to autoplay later in the background.
   */
  const ensureBothUnlocked = useCallback(() => {
    if (standbyUnlockedRef.current) return;
    const standby = getStandbyAudio();
    if (!standby) return;

    try {
      standby.src = SILENT_AUDIO_URI;
      standby.volume = 0;
      const p = standby.play();
      if (p) {
        p.then(() => {
          standby.pause();
          standbyUnlockedRef.current = true;
          const currentVol = isFinite(volume) && volume >= 0 && volume <= 1 ? volume : DEFAULT_VOLUME;
          standby.volume = currentVol;
          console.log("[AUDIO ENGINE] Standby audio element successfully unlocked for background autoplay");
        }).catch((err) => {
          console.warn("[AUDIO ENGINE] Standby unlock catch:", err);
        });
      }
    } catch (e) {
      console.warn("[AUDIO ENGINE] Standby unlock threw:", e);
    }
  }, [getStandbyAudio, volume]);

  /**
   * Standby Pre-buffering:
   * Preloads the upcoming track onto the standby audio element via the proxy stream.
   * When the active track finishes, the standby element already has buffered audio frames,
   * making the handoff instantaneous even with the phone locked in a pocket.
   */
  const syncStandbyPreload = useCallback((nextTrackCandidate?: PlayableTrack | null) => {
    if (repeatModeRef.current === "one") {
      standbyPreloadedTrackRef.current = null;
      return;
    }

    let candidate = nextTrackCandidate;
    if (candidate === undefined) {
      const { queue, history } = queueStateRef.current;
      const current = currentTrackRef.current;
      const currentIdx = current ? queue.findIndex((t) => t.videoId === current.videoId) : -1;
      const remainingQueue = currentIdx !== -1 ? queue.slice(currentIdx + 1) : queue;

      if (remainingQueue.length > 0) {
        candidate = remainingQueue[0];
      } else if (repeatModeRef.current === "all") {
        if (repeatCycleRef.current && repeatCycleRef.current.length > 0) {
          candidate = repeatCycleRef.current[0];
        } else {
          const cycle = masterPlaylistRef.current.length > 0
            ? masterPlaylistRef.current
            : (allTracksRef.current.length > 0
              ? allTracksRef.current
              : (current ? [...[...history].reverse(), current] : [...history].reverse()));
          if (cycle.length > 0) {
            if (shuffleOnRef.current && cycle.length > 1) {
              const shuffled = shuffleArray(cycle, true);
              candidate = shuffled[0];
              repeatCycleRef.current = shuffled;
            } else {
              candidate = cycle[0];
              repeatCycleRef.current = cycle;
            }
          }
        }
      }
    }

    if (!candidate) {
      standbyPreloadedTrackRef.current = null;
      return;
    }

    if (standbyPreloadedTrackRef.current?.videoId === candidate.videoId) {
      return;
    }

    const standby = getStandbyAudio();
    if (!standby) return;

    standby.pause();
    const streamUrl = getProxyStreamUrl(candidate.videoId);
    standby.preload = "auto";
    standby.loop = false;
    standby.src = streamUrl;
    standby.load();
    standby.pause(); // Mutelock: Double pause to guarantee standby stays paused on iOS
    standbyPreloadedTrackRef.current = { videoId: candidate.videoId, url: streamUrl };
    console.log(`[AUDIO ENGINE] Pre-buffered track on standby (${activeAudioSlotRef.current === "A" ? "Slot B" : "Slot A"}):`, candidate.title);
  }, [getStandbyAudio]);

  // Sync standby preload whenever queue or repeatMode changes
  useEffect(() => {
    if (!currentTrack) return;
    if (isAutoAdvancingRef.current) return;
    syncStandbyPreload();
  }, [currentTrack, queueState.queue, repeatMode, syncStandbyPreload]);

  // ── Create both audio elements on mount ───────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;

    const createAudioElement = (slot: string): HTMLAudioElement => {
      const audio = new Audio();
      audio.preload = "auto";
      audio.setAttribute("playsinline", "");
      audio.setAttribute("webkit-playsinline", "");
      audio.setAttribute("data-slot", slot);
      const saved = parseFloat(localStorage.getItem(VOLUME_KEY) ?? String(DEFAULT_VOLUME));
      audio.volume = isFinite(saved) && saved >= 0 && saved <= 1 ? saved : DEFAULT_VOLUME;

      if (typeof document !== "undefined" && document.body) {
        audio.style.position = "fixed";
        audio.style.width = "0px";
        audio.style.height = "0px";
        audio.style.opacity = "0";
        audio.style.pointerEvents = "none";
        audio.setAttribute("aria-hidden", "true");
        document.body.appendChild(audio);
      }
      return audio;
    };

    const audioA = createAudioElement("A");
    const audioB = createAudioElement("B");

    audioARef.current = audioA;
    audioBRef.current = audioB;
    activeAudioSlotRef.current = "A";
    audioRef.current = audioA;

    return () => {
      const elements = [audioA, audioB];
      for (const el of elements) {
        el.pause();
        el.loop = false;
        el.src = "";
        el.load();
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }
      audioARef.current = null;
      audioBRef.current = null;
      audioRef.current = null;
    };
  }, []);

  // ── Core: resolve stream and play ─────────────────────────────────────────

  const directLoadTrack = useCallback(async (
    track: PlayableTrack,
    overrideSequence?: PlayableTrack[],
    startOffsetSeconds?: number
  ): Promise<void> => {
    ensureBothUnlocked();

    currentTrackRef.current = track;
    setCurrentTrack(track);

    const cachedStream = getCachedStream(track.videoId);
    currentStreamRef.current = cachedStream || null;

    const initialDuration = track.durationSeconds || cachedStream?.durationSeconds || 0;
    setDuration(initialDuration);

    const audio = getActiveAudio();
    const standby = getStandbyAudio();
    if (standby) {
      standby.pause();
      standbyPreloadedTrackRef.current = null;
      repeatCycleRef.current = null;
    }

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

    if (audio) {
      audio.loop = (repeatModeRef.current === "one");
      const targetSrc = getProxyStreamUrl(track.videoId);
      const isSameSrc = typeof window !== "undefined" && audio.src === new URL(targetSrc, window.location.href).href;

      if (!isSameSrc) {
        audio.src = targetSrc;
      }

      console.log(`[SONG CHANGED] Slot ${activeAudioSlotRef.current} | Judul: ${track.title} | Artis: ${track.channelName || "Dengarkan"}`);
      console.log(`[MEDIA EVENT] PLAY | Time: ${audio.currentTime.toFixed(1)}s / ${initialDuration.toFixed(1)}s | Paused: false`);

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

    const nextCandidate = overrideSequence && overrideSequence.length > 1
      ? overrideSequence[1]
      : (queueStateRef.current.queue.length > 0 ? queueStateRef.current.queue[0] : null);
    syncStandbyPreload(nextCandidate);

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
  }, [ensureBothUnlocked, getActiveAudio, syncStandbyPreload]);

  const loadTrack = useCallback(async (track: PlayableTrack) => {
    await directLoadTrack(track);
  }, [directLoadTrack]);

  const playTrack = useCallback(async (track: PlayableTrack, resetQueue = false) => {
    repeatCycleRef.current = null;
    if (resetQueue) {
      masterPlaylistRef.current = [track];
      dispatchQueue({ type: "CLEAR" });
      await directLoadTrack(track, [track]);
    } else {
      masterPlaylistRef.current = [...masterPlaylistRef.current, track];
      if (currentTrackRef.current) {
        dispatchQueue({ type: "PUSH_HISTORY", track: currentTrackRef.current });
      }
      await directLoadTrack(track);
    }
  }, [directLoadTrack]);

  const playPlaylist = useCallback(async (
    tracks: PlayableTrack[],
    startIndex: number = 0,
  ) => {
    if (tracks.length === 0) return;
    const idx     = Math.max(0, Math.min(startIndex, tracks.length - 1));
    const current = tracks[idx];
    masterPlaylistRef.current = tracks;
    repeatCycleRef.current = null;
    dispatchQueue({ type: "LOAD_PLAYLIST", tracks, startIndex: idx });

    await directLoadTrack(current);
  }, [directLoadTrack]);

  // ── Controls ──────────────────────────────────────────────────────────────

  const play = useCallback(async () => {
    ensureBothUnlocked();
    const audio = getActiveAudio();
    if (!audio) return;
    try {
      const playPromise = audio.play();
      if (playPromise) await playPromise;
    } catch (err) {
      console.error(err);
    }
  }, [ensureBothUnlocked, getActiveAudio]);

  const pause = useCallback(() => {
    getActiveAudio()?.pause();
  }, [getActiveAudio]);

  const toggle = useCallback(async () => {
    ensureBothUnlocked();
    const audio = getActiveAudio();
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
  }, [ensureBothUnlocked, getActiveAudio]);

  const getCurrentTime = useCallback(() => {
    const audio = getActiveAudio();
    if (!audio || !isFinite(audio.currentTime)) return 0;
    return audio.currentTime;
  }, [getActiveAudio]);

  const seek = useCallback(async (seconds: number) => {
    const audio = getActiveAudio();
    if (!audio || !isFinite(seconds)) return;

    const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
    const dur = getCanonicalDuration(meta, audio.duration);

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
  }, [getActiveAudio]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    if (audioARef.current) audioARef.current.volume = clamped;
    if (audioBRef.current) audioBRef.current.volume = clamped;
    setVolumeState(clamped);
    try { localStorage.setItem(VOLUME_KEY, String(clamped)); } catch { /* ignore */ }
    if (clamped > 0) setIsMuted(false);
  }, []);

  const toggleMute = useCallback(() => {
    const active = getActiveAudio();
    if (!active) return;
    const nextMuted = !active.muted;
    if (audioARef.current) audioARef.current.muted = nextMuted;
    if (audioBRef.current) audioBRef.current.muted = nextMuted;
    setIsMuted(nextMuted);
  }, [getActiveAudio]);

  const clear = useCallback(() => {
    standbyPreloadedTrackRef.current = null;
    if (audioARef.current) {
      audioARef.current.pause();
      audioARef.current.loop = false;
      audioARef.current.src = "";
    }
    if (audioBRef.current) {
      audioBRef.current.pause();
      audioBRef.current.loop = false;
      audioBRef.current.src = "";
    }
    setCurrentTrack(null);
    setCurrentStream(null);
    setPlayerState("idle");
    setDuration(0);
    masterPlaylistRef.current = [];
    repeatCycleRef.current = null;
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
    repeatCycleRef.current = null;
    if (!currentTrackRef.current) {
      void playTrack(t);
    } else {
      masterPlaylistRef.current = [...masterPlaylistRef.current, t];
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
      masterPlaylistRef.current = filtered;
      repeatCycleRef.current = null;
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
    masterPlaylistRef.current = reordered;
    repeatCycleRef.current = null;

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
    repeatCycleRef.current = null;

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
    repeatCycleRef.current = null;
    try { localStorage.setItem(REPEAT_KEY, m); } catch { /* ignore */ }

    const activeAudio = getActiveAudio();
    if (activeAudio) {
      activeAudio.loop = (m === "one");
    }

    if (m !== "one") {
      syncStandbyPreload();
    } else {
      standbyPreloadedTrackRef.current = null;
    }
  }, [getActiveAudio, syncStandbyPreload]);

  // ── Navigation (Ping-Pong Handoff) ────────────────────────────────────────

  const advanceNext = useCallback(async () => {
    const now = Date.now();
    if (now - lastAdvanceTimeRef.current < 500) {
      return;
    }
    lastAdvanceTimeRef.current = now;
    isAdvancingRef.current = true;

    try {
      const activeAudio = getActiveAudio();
      const current = currentTrackRef.current;
      const repeat = repeatModeRef.current;
      const shuffleOn = shuffleOnRef.current;
      const { queue, history } = queueStateRef.current;

      // 1. repeat=one → restart current track synchronously on the active element
      if (repeat === "one" && current) {
        if (activeAudio) {
          activeAudio.currentTime = 0;
          try {
            const playPromise = activeAudio.play();
            if (playPromise) await playPromise;
          } catch (e) {
            console.error("Failed to replay track in repeat=one", e);
          }
        }
        return;
      }

      // Determine next track using Self-Reconciling Index Offset:
      let nextTrack: PlayableTrack | null = null;
      let chosenIdx = 0;
      const currentIdx = current ? queue.findIndex((t) => t.videoId === current.videoId) : -1;
      const remainingQueue = currentIdx !== -1 ? queue.slice(currentIdx + 1) : queue;
      let newQueue = remainingQueue;

      if (remainingQueue.length > 0) {
        nextTrack = remainingQueue[0];
        newQueue = remainingQueue.slice(1);
      } else if (repeat === "all") {
        if (repeatCycleRef.current && repeatCycleRef.current.length > 0) {
          // Preload already prepared the next cycle.
          // CRITICAL: DO NOT reshuffle here to prevent reshuffle desync with standby preloaded track!
          const cycle = repeatCycleRef.current;
          repeatCycleRef.current = null;
          nextTrack = { ...cycle[0] };
          newQueue = cycle.slice(1);
        } else {
          let full = masterPlaylistRef.current.length > 0
            ? masterPlaylistRef.current
            : (allTracksRef.current.length > 0
                ? allTracksRef.current
                : (current ? [...[...history].reverse(), current] : [...history].reverse()));
          if (full.length > 0) {
            if (shuffleOn && full.length > 1) {
              full = shuffleArray(full, true);
            }
            nextTrack = { ...full[0] };
            newQueue = full.slice(1);
          }
        }
      }

      // If no next track (end of queue in repeat=none)
      if (!nextTrack) {
        dispatchQueue({ type: "ADVANCE_NEXT", current, shuffleOn, repeatMode: repeat });
        if (activeAudio) {
          activeAudio.pause();
          activeAudio.src = "";
        }
        setPlayerState("idle");
        return;
      }

      // If repeating the exact same track (repeat=all with single track in playlist)
      if (nextTrack.videoId === current?.videoId) {
        dispatchQueue({
          type: "ADVANCE_NEXT",
          current,
          shuffleOn,
          repeatMode: repeat,
          chosenIndex: 0,
          nextTrack,
          newQueue,
        });
        if (activeAudio) {
          activeAudio.currentTime = 0;
          try {
            const playPromise = activeAudio.play();
            if (playPromise) await playPromise;
          } catch (e) {
            console.error("Failed to replay track in repeat=all single track", e);
          }
        }
        return;
      }

      isAutoAdvancingRef.current = true;

      // Dispatch queue advancement
      dispatchQueue({
        type: "ADVANCE_NEXT",
        current,
        shuffleOn,
        repeatMode: repeat,
        chosenIndex: 0,
        nextTrack,
        newQueue,
      });

      // PING-PONG HANDOFF:
      const isStandbyPreloaded = standbyPreloadedTrackRef.current?.videoId === nextTrack.videoId;
      const standbyAudio = getStandbyAudio();

      if (standbyAudio && isStandbyPreloaded) {
        isHandoffInProgressRef.current = true;
        try {
          const { oldActive, newActive } = switchActiveSlot();
          currentTrackRef.current = nextTrack;
          setCurrentTrack(nextTrack);

          // Synchronize stream cache and duration for nextTrack to prevent stale duration bugs
          const cachedStream = getCachedStream(nextTrack.videoId);
          currentStreamRef.current = cachedStream || null;
          setCurrentStream(cachedStream || null);

          const initialDur = nextTrack.durationSeconds || cachedStream?.durationSeconds || 0;
          setDuration(initialDur);

          if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
            try {
              const meta = parseTrackMeta(nextTrack.title, nextTrack.channelName, initialDur);
              navigator.mediaSession.metadata = new MediaMetadata({
                title:   meta.title,
                artist:  meta.artist,
                album:   meta.channelName || "Dengarkan",
                artwork: buildArtwork(nextTrack.thumbnailUrl),
              });
              navigator.mediaSession.playbackState = "playing";
              if (newActive) safeSetPositionState(newActive, initialDur, 0);
            } catch { /* ignore */ }
          }

          console.log(`[PING-PONG] Switching slot to ${activeAudioSlotRef.current} for: ${nextTrack.title}`);
          setPlayerState("playing");

          // Clean up previous active element immediately without tearing down AVPlayer pipeline
          if (oldActive) {
            oldActive.pause();
          }

          // Start playing the new active element
          if (newActive) {
            newActive.loop = (repeat === "one");
            newActive.volume = isFinite(volume) && volume >= 0 && volume <= 1 ? volume : DEFAULT_VOLUME;
            try {
              const playPromise = newActive.play();
              if (playPromise) void playPromise.catch((e) => console.warn("[PING-PONG] Play failed:", e));
            } catch (e) {
              console.warn("[PING-PONG] Play threw:", e);
            }
          }

          standbyPreloadedTrackRef.current = null;
          let upcomingCandidate: PlayableTrack | null = null;
          if (newQueue.length > 0) {
            upcomingCandidate = newQueue[0];
          } else if (repeat === "all") {
            const cycle = masterPlaylistRef.current.length > 0
              ? masterPlaylistRef.current
              : (allTracksRef.current.length > 0
                ? allTracksRef.current
                : [...[...queueStateRef.current.history].reverse(), current, nextTrack].filter(
                    (t): t is PlayableTrack => Boolean(t)
                  ));
            if (cycle.length > 0) {
              if (shuffleOn && cycle.length > 1) {
                const shuffledCycle = shuffleArray(cycle, true);
                upcomingCandidate = shuffledCycle[0];
                repeatCycleRef.current = shuffledCycle;
              } else {
                upcomingCandidate = cycle[0];
                repeatCycleRef.current = cycle;
              }
            }
          }
          syncStandbyPreload(upcomingCandidate);
          isAutoAdvancingRef.current = false;

          // Fetch stream in background if not in cache to guarantee exact canonical duration
          if (!cachedStream) {
            void fetchStreamWithCache(nextTrack.videoId)
              .then((stream) => {
                if (currentTrackRef.current?.videoId === nextTrack.videoId) {
                  currentStreamRef.current = stream;
                  setCurrentStream(stream);
                  if (stream.durationSeconds && stream.durationSeconds > 0) {
                    setDuration(stream.durationSeconds);
                  }
                }
              })
              .catch((err) => {
                console.warn("Background fetchStreamWithCache failed on ping-pong switch:", err);
              });
          }
        } finally {
          isHandoffInProgressRef.current = false;
        }
      } else {
        await directLoadTrack(nextTrack);
      }
    } finally {
      setTimeout(() => {
        isAdvancingRef.current = false;
      }, 1000);
    }
  }, [getActiveAudio, getStandbyAudio, switchActiveSlot, directLoadTrack, syncStandbyPreload, volume]);

  const advancePrev = useCallback(async () => {
    const audio = getActiveAudio();
    const cur = audio?.currentTime ?? 0;
    if (cur > 3) {
      if (audio) {
        audio.currentTime = 0;
        try {
          const playPromise = audio.play();
          if (playPromise) await playPromise;
        } catch { /* ignore */ }
      }
      return;
    }

    const { history } = queueStateRef.current;
    if (history.length === 0) return;

    const prevTrack = history[0];
    const current = currentTrackRef.current;

    dispatchQueue({ type: "ADVANCE_PREV", current });
    await directLoadTrack(prevTrack);
  }, [directLoadTrack, getActiveAudio]);

  const playTrackAtIndex = useCallback(async (index: number) => {
    const all = allTracksRef.current;
    if (index < 0 || index >= all.length) return;

    const curIdx = currentTrackRef.current ? queueStateRef.current.history.length : -1;
    if (index === curIdx) {
      const audio = getActiveAudio();
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
    repeatCycleRef.current = null;
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
  }, [directLoadTrack, getActiveAudio]);

  const playFromQueue = playTrackAtIndex;

  const next = advanceNext;
  const previous = advancePrev;

  advanceNextRef.current = advanceNext;
  advancePrevRef.current = advancePrev;

  // ── Audio element event listeners ─────────────────────────────────────────

  useEffect(() => {
    const audioA = audioARef.current;
    const audioB = audioBRef.current;
    if (!audioA || !audioB) return;

    const elements = [audioA, audioB];

    const onPlay = (e: Event) => {
      const standby = getStandbyAudio();
      // Standby Audio Mutelock: Immediately force pause if standby attempts unauthorized playback
      if (standby && e.target === standby && !isHandoffInProgressRef.current) {
        console.warn("[MUTELOCK] Standby element received unauthorized play event! Forcing pause immediately.");
        standby.pause();
        return;
      }
      if (e.target !== getActiveAudio()) {
        (e.target as HTMLAudioElement)?.pause();
        return;
      }
    };

    const onPlaying = (e: Event) => {
      const standby = getStandbyAudio();
      // Standby Audio Mutelock: Intercept any playing event on standby outside authorized handoff
      if (standby && e.target === standby && !isHandoffInProgressRef.current) {
        console.warn("[MUTELOCK] Standby element started playing without handoff! Forcing pause immediately.");
        standby.pause();
        return;
      }
      if (e.target !== getActiveAudio()) {
        (e.target as HTMLAudioElement)?.pause();
        return;
      }
      setTimeout(() => {
        isAdvancingRef.current = false;
      }, 1000);
      const audio = getActiveAudio();
      if (!audio) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      console.log(`[MEDIA EVENT] PLAYING (Slot ${activeAudioSlotRef.current}) | Time: ${audio.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s | Paused: false`);
      setPlayerState("playing");
    };

    const onPause = (e: Event) => {
      if (e.target !== getActiveAudio()) return;
      const audio = getActiveAudio();
      if (!audio) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = getCanonicalDuration(meta, audio.duration);
      console.log(`[MEDIA EVENT] PAUSE (Slot ${activeAudioSlotRef.current}) | Time: ${audio.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s | Paused: true`);
      if (isAdvancingRef.current) return;

      // Safari/WebKit fires 'pause' right before 'ended' at the end of the track.
      if (
        audio.ended ||
        (isFinite(dur) && dur > 0 && audio.currentTime >= dur - 0.8) ||
        (isFinite(audio.duration) && audio.duration > 0 && audio.currentTime >= audio.duration - 0.8)
      ) {
        return;
      }

      setPlayerState((prev) => (prev === "refreshing" ? prev : "paused"));
    };

    const onWaiting = (e: Event) => {
      if (e.target !== getActiveAudio()) return;
      if (isAdvancingRef.current) return;
      setPlayerState("buffering");
    };

    const onStalled = (e: Event) => {
      if (e.target !== getActiveAudio()) return;
      if (isAdvancingRef.current) return;
      setPlayerState("buffering");
    };

    const onCanPlay = (e: Event) => {
      const standby = getStandbyAudio();
      if (standby && e.target === standby && !isHandoffInProgressRef.current) {
        standby.pause();
        return;
      }
      if (e.target !== getActiveAudio()) {
        (e.target as HTMLAudioElement)?.pause();
        return;
      }
      const audio = getActiveAudio();
      if (audio && !audio.paused) setPlayerState("playing");
    };

    const onLoadedMetadata = (e: Event) => {
      if (e.target !== getActiveAudio()) return;
      const audio = getActiveAudio();
      if (!audio) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    const onDurationChange = (e: Event) => {
      if (e.target !== getActiveAudio()) return;
      const audio = getActiveAudio();
      if (!audio) return;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonical = getCanonicalDuration(meta, audio.duration);
      if (canonical > 0) setDuration(canonical);
    };

    const onProgress = () => { /* buffer bar sync if needed */ };

    const onEnded = (e: Event) => {
      const standby = getStandbyAudio();
      if (standby && e.target === standby) {
        standby.pause();
        return;
      }
      if (e.target !== getActiveAudio()) return;
      const audio = getActiveAudio();
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const dur = audio ? getCanonicalDuration(meta, audio.duration) : 0;
      console.log(`[MEDIA EVENT] ENDED (Slot ${activeAudioSlotRef.current}) | Time: ${audio?.currentTime.toFixed(1)}s / ${dur.toFixed(1)}s | Paused: true`);
      void advanceNextRef.current();
    };

    const onTimeUpdate = (e: Event) => {
      const standby = getStandbyAudio();
      if (standby && e.target === standby) {
        standby.pause();
        return;
      }
      if (e.target !== getActiveAudio()) return;
      if (isAdvancingRef.current) return;
      const audio = getActiveAudio();
      if (!audio) return;

      const cur = audio.currentTime;
      const meta = currentStreamRef.current?.durationSeconds || currentTrackRef.current?.durationSeconds || 0;
      const canonicalDur = getCanonicalDuration(meta, audio.duration);

      // Fallback safety watchdog:
      // The browser's native 'ended' event (onEnded above) is the authoritative, precise trigger.
      // This watchdog ONLY acts as a safety net if audio reached its full duration AND has stopped/stalled,
      // never interrupting playback while the track is still actively playing (cur < canonicalDur).
      if (
        isFinite(canonicalDur) &&
        canonicalDur > 5 &&
        cur >= canonicalDur &&
        (audio.ended || audio.paused || cur >= canonicalDur + 1.5)
      ) {
        console.log(`[MEDIA EVENT] SAFETY WATCHDOG FIRED: ${cur.toFixed(1)}s / ${canonicalDur.toFixed(1)}s`);
        void advanceNextRef.current();
      }
    };

    const onError = async (e: Event) => {
      if (e.target !== getActiveAudio()) return;
      isAdvancingRef.current = false;
      const track = currentTrackRef.current;
      const audio = getActiveAudio();
      if (!track || !audio) { setPlayerState("error"); return; }
      if (refreshingRef.current) return;

      const savedTime  = audio.currentTime;
      const wasPlaying = !audio.paused;

      setPlayerState("refreshing");
      refreshingRef.current = true;

      const MAX_ATTEMPTS = 3;
      const BASE_DELAY   = 1_500;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
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
          return;
        } catch (err: unknown) {
          const apiErr = err as { statusCode?: number };
          if (apiErr?.statusCode === 404 || apiErr?.statusCode === 422) break;
          const delay = apiErr?.statusCode === 429
            ? BASE_DELAY * 4 * attempt
            : BASE_DELAY * 2 ** (attempt - 1);
          if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, delay));
        }
      }

      refreshingRef.current = false;
      setPlayerState("error");
    };

    for (const el of elements) {
      el.addEventListener("play",            onPlay);
      el.addEventListener("playing",         onPlaying);
      el.addEventListener("pause",           onPause);
      el.addEventListener("waiting",         onWaiting);
      el.addEventListener("stalled",         onStalled);
      el.addEventListener("canplay",         onCanPlay);
      el.addEventListener("loadedmetadata",  onLoadedMetadata);
      el.addEventListener("durationchange",  onDurationChange);
      el.addEventListener("progress",        onProgress);
      el.addEventListener("timeupdate",      onTimeUpdate);
      el.addEventListener("ended",           onEnded);
      el.addEventListener("error",           onError);
    }

    return () => {
      for (const el of elements) {
        el.removeEventListener("play",           onPlay);
        el.removeEventListener("playing",        onPlaying);
        el.removeEventListener("pause",          onPause);
        el.removeEventListener("waiting",        onWaiting);
        el.removeEventListener("stalled",        onStalled);
        el.removeEventListener("canplay",        onCanPlay);
        el.removeEventListener("loadedmetadata", onLoadedMetadata);
        el.removeEventListener("durationchange", onDurationChange);
        el.removeEventListener("progress",       onProgress);
        el.removeEventListener("timeupdate",      onTimeUpdate);
        el.removeEventListener("ended",          onEnded);
        el.removeEventListener("error",          onError);
      }
    };
  }, [getActiveAudio, getStandbyAudio]);

  // ── Media Session (Lock Screen / AirPods / Bluetooth) ─────────────────────

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
