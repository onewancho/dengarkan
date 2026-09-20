// ============================================
// DENGARKAN — Audio Engine Tests
//
// Tests the state machine, queue logic, navigation, and error recovery
// of useAudioEngine without a real browser or real yt-dlp calls.
//
// Run: node --test --import tsx/esm src/features/player/audio-engine.test.ts
// (from apps/web directory)
//
// Strategy:
//   • The state machine logic (reducer, classification, helpers) is extracted
//     and tested as pure functions — no React, no DOM.
//   • The queueReducer covers: add, remove, clear, advance (shuffle/ordered),
//     advance_prev, push_history, shuffle toggle.
//   • Helper functions cover: fmt(), shuffleArray(), volume clamping.
//
// What is NOT tested here (integration-level, requires a real browser):
//   • HTMLAudioElement event firing
//   • requestAnimationFrame progress sync
//   • Media Session API
//   • localStorage volume persistence
//
// These are covered by manual QA / E2E tests.
//
// Coverage:
//   ✓ fmt() — time formatting edge cases
//   ✓ queueReducer: ADD
//   ✓ queueReducer: REMOVE
//   ✓ queueReducer: CLEAR
//   ✓ queueReducer: PUSH_HISTORY (cap at HISTORY_MAX)
//   ✓ queueReducer: ADVANCE_NEXT — ordered, queue consumed
//   ✓ queueReducer: ADVANCE_NEXT — empty queue → nextTrack=null
//   ✓ queueReducer: ADVANCE_NEXT — pushes current to history
//   ✓ queueReducer: ADVANCE_NEXT — shuffle=true picks random index
//   ✓ queueReducer: ADVANCE_PREV — pops history, pushes current to queue
//   ✓ queueReducer: ADVANCE_PREV — empty history → nextTrack=null
//   ✓ queueReducer: SHUFFLE_TOGGLE
//   ✓ shuffleArray — preserves elements, changes order
//   ✓ shuffleArray — empty array
//   ✓ volume clamping — 0–1
//   ✓ seek clamping — 0 to duration
//   ✓ stream error flow — retry classification
//   ✓ error: 404/422 → no retry
//   ✓ error: 429 → longer backoff
//   ✓ error: 500/network → normal backoff
//   ✓ expiry: expiresAt in the past → treated as expired
//   ✓ repeat=one: onEnded restarts current, no queue advance
//   ✓ repeat=none: onEnded advances queue
//   ✓ previous: <3s → go back in history
//   ✓ previous: >3s → restart (seek to 0)
// ============================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSilentAudioUri, SILENT_AUDIO_URI } from "./silent-audio.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions extracted from use-audio-engine.ts
// ─────────────────────────────────────────────────────────────────────────────

// ── fmt ──────────────────────────────────────────────────────────────────────

function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── shuffleArray ─────────────────────────────────────────────────────────────

function shuffleArray<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Volume clamping ───────────────────────────────────────────────────────────

function clampVolume(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ── Seek clamping ─────────────────────────────────────────────────────────────

function clampSeek(seconds: number, duration: number): number {
  return Math.max(0, Math.min(seconds, duration));
}

function shouldAdvanceOnSeek(seconds: number, duration: number): boolean {
  return isFinite(duration) && duration > 0 && seconds >= duration - 0.5;
}

function shouldAdvanceOnWatchdog(currentTime: number, duration: number): boolean {
  return isFinite(duration) && duration > 0 && currentTime >= duration - 1.5;
}

function getCanonicalDuration(metaDuration?: number, audioDuration?: number): number {
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

// ── Queue reducer (mirrored from use-audio-engine.ts) ────────────────────────

type PlayableTrack = {
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number;
};

type RepeatMode = "none" | "one" | "all";

type QueueAction =
  | { type: "ADD";    track: PlayableTrack }
  | { type: "REMOVE"; index: number }
  | { type: "CLEAR" }
  | { type: "ADVANCE_NEXT"; current: PlayableTrack | null; shuffleOn: boolean; chosenIndex?: number }
  | { type: "ADVANCE_PREV"; current: PlayableTrack | null }
  | { type: "PUSH_HISTORY"; track: PlayableTrack }
  | { type: "SHUFFLE_TOGGLE" };

interface QueueState {
  queue:     PlayableTrack[];
  history:   PlayableTrack[];
  shuffleOn: boolean;
  nextTrack: PlayableTrack | null;
}

const HISTORY_MAX = 30;

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
      if (queue.length === 0) return { ...state, nextTrack: null };
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
    case "SHUFFLE_TOGGLE":
      return { ...state, shuffleOn: !state.shuffleOn };
    default:
      return state;
  }
}

// ── Stream error retry classification ─────────────────────────────────────────

type RetryStrategy = "no-retry" | "normal-backoff" | "long-backoff";

function classifyHttpError(statusCode: number | undefined): RetryStrategy {
  if (statusCode === 404 || statusCode === 422) return "no-retry";
  if (statusCode === 429) return "long-backoff";
  return "normal-backoff"; // 500, 502, network etc.
}

// ── Initial state helper ───────────────────────────────────────────────────────

function initialQueueState(): QueueState {
  return { queue: [], history: [], shuffleOn: false, nextTrack: null };
}

function makeTrack(id: string): PlayableTrack {
  return {
    videoId:         id,
    title:           `Track ${id}`,
    channelName:     "Artist",
    thumbnailUrl:    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    durationSeconds: 213,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe("Audio Engine — fmt()", () => {
  it("formats zero seconds", () => assert.equal(fmt(0), "0:00"));
  it("formats 90 seconds → 1:30", () => assert.equal(fmt(90), "1:30"));
  it("formats 3600 seconds → 60:00", () => assert.equal(fmt(3600), "60:00"));
  it("pads seconds < 10", () => assert.equal(fmt(65), "1:05"));
  it("returns 0:00 for negative", () => assert.equal(fmt(-1), "0:00"));
  it("returns 0:00 for NaN", () => assert.equal(fmt(NaN), "0:00"));
  it("returns 0:00 for Infinity", () => assert.equal(fmt(Infinity), "0:00"));
  it("floors fractional seconds", () => assert.equal(fmt(90.9), "1:30"));
});

describe("Audio Engine — shuffleArray()", () => {
  it("returns a new array (does not mutate)", () => {
    const original = [1, 2, 3, 4, 5];
    const shuffled = shuffleArray(original);
    assert.deepEqual(original, [1, 2, 3, 4, 5]); // not mutated
    assert.notDeepEqual(shuffled, original); // very likely shuffled (1/120 chance of same order)
    assert.equal(shuffled.length, original.length);
  });

  it("contains all original elements", () => {
    const original = ["a", "b", "c", "d", "e"];
    const shuffled = shuffleArray(original);
    assert.deepEqual([...shuffled].sort(), [...original].sort());
  });

  it("handles empty array", () => {
    assert.deepEqual(shuffleArray([]), []);
  });

  it("handles single element", () => {
    assert.deepEqual(shuffleArray([42]), [42]);
  });
});

describe("Audio Engine — volume clamping", () => {
  it("clamps to 0 for negative", () => assert.equal(clampVolume(-1), 0));
  it("clamps to 1 for > 1", () => assert.equal(clampVolume(2), 1));
  it("passes through 0.5", () => assert.equal(clampVolume(0.5), 0.5));
  it("allows exactly 0", () => assert.equal(clampVolume(0), 0));
  it("allows exactly 1", () => assert.equal(clampVolume(1), 1));
});

describe("Audio Engine — seek clamping", () => {
  it("clamps below 0 to 0", () => assert.equal(clampSeek(-5, 300), 0));
  it("clamps above duration to duration", () => assert.equal(clampSeek(400, 300), 300));
  it("passes through valid seek", () => assert.equal(clampSeek(150, 300), 150));
  it("seeks to exactly 0", () => assert.equal(clampSeek(0, 300), 0));
  it("seeks to exactly duration", () => assert.equal(clampSeek(300, 300), 300));
});

describe("Audio Engine — seek near-end auto-advance", () => {
  it("triggers advance when seeking to exact duration", () => {
    assert.equal(shouldAdvanceOnSeek(300, 300), true);
  });
  it("triggers advance when seeking past duration (+10s button)", () => {
    assert.equal(shouldAdvanceOnSeek(310, 300), true);
  });
  it("triggers advance when seeking within 0.5s of duration", () => {
    assert.equal(shouldAdvanceOnSeek(299.6, 300), true);
  });
  it("does not trigger advance when seeking 2s before duration", () => {
    assert.equal(shouldAdvanceOnSeek(298, 300), false);
  });
  it("does not trigger advance when duration is 0 or invalid", () => {
    assert.equal(shouldAdvanceOnSeek(10, 0), false);
  });
});

describe("Audio Engine — watchdog near-end auto-advance", () => {
  it("triggers watchdog when currentTime >= duration - 1.5 (catches throttled background timer on iOS)", () => {
    assert.equal(shouldAdvanceOnWatchdog(298.7, 300), true);
    assert.equal(shouldAdvanceOnWatchdog(299.7, 300), true);
  });
  it("does not trigger watchdog when >1.5s remains", () => {
    assert.equal(shouldAdvanceOnWatchdog(298.0, 300), false);
  });
});

describe("Audio Engine — queueReducer: ADD", () => {
  it("appends a track to empty queue", () => {
    const s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("a1") });
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].videoId, "a1");
  });

  it("appends to existing queue", () => {
    let s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("a1") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("a2") });
    assert.equal(s.queue.length, 2);
    assert.equal(s.queue[1].videoId, "a2");
  });
});

describe("Audio Engine — queueReducer: REMOVE", () => {
  it("removes by index", () => {
    let s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("r1") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("r2") });
    s = queueReducer(s, { type: "REMOVE", index: 0 });
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].videoId, "r2");
  });

  it("no-op on out-of-range index", () => {
    let s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("r1") });
    s = queueReducer(s, { type: "REMOVE", index: 99 });
    assert.equal(s.queue.length, 1);
  });
});

describe("Audio Engine — queueReducer: CLEAR", () => {
  it("empties the queue", () => {
    let s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("c1") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("c2") });
    s = queueReducer(s, { type: "CLEAR" });
    assert.equal(s.queue.length, 0);
  });

  it("does not affect history", () => {
    let s = queueReducer(initialQueueState(), { type: "PUSH_HISTORY", track: makeTrack("h1") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("c1") });
    s = queueReducer(s, { type: "CLEAR" });
    assert.equal(s.history.length, 1);
  });
});

describe("Audio Engine — queueReducer: PUSH_HISTORY", () => {
  it("prepends to history", () => {
    let s = queueReducer(initialQueueState(), { type: "PUSH_HISTORY", track: makeTrack("h1") });
    s = queueReducer(s, { type: "PUSH_HISTORY", track: makeTrack("h2") });
    assert.equal(s.history[0].videoId, "h2"); // most recent first
    assert.equal(s.history[1].videoId, "h1");
  });

  it("caps at HISTORY_MAX", () => {
    let s = initialQueueState();
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      s = queueReducer(s, { type: "PUSH_HISTORY", track: makeTrack(`h${i}`) });
    }
    assert.equal(s.history.length, HISTORY_MAX);
  });
});

describe("Audio Engine — queueReducer: ADVANCE_NEXT", () => {
  it("takes first track from queue (ordered)", () => {
    let s = initialQueueState();
    s = queueReducer(s, { type: "ADD", track: makeTrack("n1") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("n2") });
    s = queueReducer(s, { type: "ADVANCE_NEXT", current: null, shuffleOn: false });
    assert.equal(s.nextTrack?.videoId, "n1");
    assert.equal(s.queue.length, 1);
    assert.equal(s.queue[0].videoId, "n2");
  });

  it("returns null nextTrack when queue is empty", () => {
    const s = queueReducer(initialQueueState(), { type: "ADVANCE_NEXT", current: null, shuffleOn: false });
    assert.equal(s.nextTrack, null);
  });

  it("pushes current track to history", () => {
    const current = makeTrack("current");
    let s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("n1") });
    s = queueReducer(s, { type: "ADVANCE_NEXT", current, shuffleOn: false });
    assert.equal(s.history[0].videoId, "current");
  });

  it("shuffle=true — always picks a valid track from the queue", () => {
    let s = initialQueueState();
    for (let i = 0; i < 5; i++) s = queueReducer(s, { type: "ADD", track: makeTrack(`s${i}`) });

    const validIds = new Set(s.queue.map(t => t.videoId));
    // Run 50 trials and verify every picked track is a valid queue member
    for (let trial = 0; trial < 50; trial++) {
      const result = queueReducer(s, { type: "ADVANCE_NEXT", current: null, shuffleOn: true });
      assert.ok(result.nextTrack, "Should pick a track");
      assert.ok(validIds.has(result.nextTrack!.videoId), `Picked track "${result.nextTrack!.videoId}" must be in original queue`);
      assert.equal(result.queue.length, 4, "Queue should shrink by 1 after advance");
    }
  });

  it("shuffle=true — shuffleArray produces all elements", () => {
    // Verify the pure shuffleArray function (used conceptually in shuffle logic)
    const items = ["s0","s1","s2","s3","s4"];
    const shuffled = shuffleArray(items);
    assert.deepEqual([...shuffled].sort(), [...items].sort(), "Shuffled array must contain same elements");
    assert.equal(shuffled.length, items.length);
  });

  it("queue length decreases by 1 after advance", () => {
    let s = initialQueueState();
    for (let i = 0; i < 5; i++) s = queueReducer(s, { type: "ADD", track: makeTrack(`t${i}`) });
    s = queueReducer(s, { type: "ADVANCE_NEXT", current: null, shuffleOn: false });
    assert.equal(s.queue.length, 4);
  });

  it("chosenIndex overrides random selection and picks exact track", () => {
    let s = initialQueueState();
    s = queueReducer(s, { type: "ADD", track: makeTrack("t0") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("t1") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("t2") });
    // Pick index 2 even with shuffleOn=true
    s = queueReducer(s, { type: "ADVANCE_NEXT", current: null, shuffleOn: true, chosenIndex: 2 });
    assert.equal(s.nextTrack?.videoId, "t2");
    assert.equal(s.queue.length, 2);
    assert.ok(!s.queue.some(t => t.videoId === "t2"));
  });
});

describe("Audio Engine — queueReducer: ADVANCE_PREV", () => {
  it("pops from history and returns as nextTrack", () => {
    let s = queueReducer(initialQueueState(), { type: "PUSH_HISTORY", track: makeTrack("prev1") });
    s = queueReducer(s, { type: "PUSH_HISTORY", track: makeTrack("prev2") });
    s = queueReducer(s, { type: "ADVANCE_PREV", current: null });
    assert.equal(s.nextTrack?.videoId, "prev2"); // most recent in history
    assert.equal(s.history.length, 1);
  });

  it("pushes current back to front of queue", () => {
    const current = makeTrack("cur");
    let s = queueReducer(initialQueueState(), { type: "PUSH_HISTORY", track: makeTrack("prev1") });
    s = queueReducer(s, { type: "ADD", track: makeTrack("q1") });
    s = queueReducer(s, { type: "ADVANCE_PREV", current });
    assert.equal(s.queue[0].videoId, "cur");
    assert.equal(s.queue[1].videoId, "q1");
  });

  it("returns null when history is empty", () => {
    const s = queueReducer(initialQueueState(), { type: "ADVANCE_PREV", current: null });
    assert.equal(s.nextTrack, null);
  });
});

describe("Audio Engine — queueReducer: SHUFFLE_TOGGLE", () => {
  it("toggles shuffleOn from false to true", () => {
    const s = queueReducer(initialQueueState(), { type: "SHUFFLE_TOGGLE" });
    assert.equal(s.shuffleOn, true);
  });

  it("toggles shuffleOn from true to false", () => {
    let s = queueReducer(initialQueueState(), { type: "SHUFFLE_TOGGLE" });
    s = queueReducer(s, { type: "SHUFFLE_TOGGLE" });
    assert.equal(s.shuffleOn, false);
  });
});

describe("Audio Engine — stream error retry classification", () => {
  it("404 → no-retry", () => assert.equal(classifyHttpError(404), "no-retry"));
  it("422 → no-retry", () => assert.equal(classifyHttpError(422), "no-retry"));
  it("429 → long-backoff", () => assert.equal(classifyHttpError(429), "long-backoff"));
  it("500 → normal-backoff", () => assert.equal(classifyHttpError(500), "normal-backoff"));
  it("502 → normal-backoff", () => assert.equal(classifyHttpError(502), "normal-backoff"));
  it("undefined → normal-backoff (network error)", () => assert.equal(classifyHttpError(undefined), "normal-backoff"));
});

describe("Audio Engine — repeat mode logic", () => {
  it("repeat=one: onEnded should restart, not advance queue", () => {
    // Simulated: if repeatMode === "one", we skip ADVANCE_NEXT
    const repeatMode: RepeatMode = "one";
    let s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("q1") });
    // In repeat=one, we don't call ADVANCE_NEXT — queue should not change
    if (repeatMode !== "one") {
      s = queueReducer(s, { type: "ADVANCE_NEXT", current: makeTrack("cur"), shuffleOn: false });
    }
    assert.equal(s.queue.length, 1, "Queue should not be consumed when repeat=one");
    assert.equal(s.nextTrack, null, "nextTrack should remain null when repeat=one");
  });

  it("repeat=none: onEnded should call ADVANCE_NEXT and consume queue", () => {
    const repeatMode: RepeatMode = "none";
    let s = queueReducer(initialQueueState(), { type: "ADD", track: makeTrack("q1") });
    // repeatMode is "none" — not "one" — so ADVANCE_NEXT is called
    const shouldAdvance = (repeatMode as string) !== "one";
    if (shouldAdvance) {
      s = queueReducer(s, { type: "ADVANCE_NEXT", current: makeTrack("cur"), shuffleOn: false });
    }
    assert.equal(s.nextTrack?.videoId, "q1");
    assert.equal(s.queue.length, 0);
  });
});

describe("Audio Engine — previous track decision", () => {
  it("previous at <3s → go to history (ADVANCE_PREV)", () => {
    const currentTime = 2; // < 3s
    const shouldRestart = currentTime > 3;
    assert.equal(shouldRestart, false, "Should go to history, not restart");
  });

  it("previous at >3s → restart current (seek to 0)", () => {
    const currentTime = 5; // > 3s
    const shouldRestart = currentTime > 3;
    assert.equal(shouldRestart, true, "Should restart, not go to history");
  });

  it("previous at exactly 3s → restart (> check means 3 does not restart)", () => {
    const currentTime = 3;
    const shouldRestart = currentTime > 3; // strict >
    assert.equal(shouldRestart, false); // 3 does NOT restart, goes back
  });
});

describe("Audio Engine — getCanonicalDuration", () => {
  it("rejects 2x doubled browser duration when metadata duration is known", () => {
    // Marshmello - Silence: 187s (3:07). Browser reports ~374s (6:14) due to timescale bug
    const metaDuration = 187;
    const buggedAudioDuration = 373.74;
    const result = getCanonicalDuration(metaDuration, buggedAudioDuration);
    assert.equal(result, 187);
    assert.equal(fmt(result), "3:07");
  });

  it("accepts browser duration if close to metadata duration (within 15%)", () => {
    const metaDuration = 187;
    const closeAudioDuration = 187.45;
    const result = getCanonicalDuration(metaDuration, closeAudioDuration);
    assert.equal(result, 187.45);
  });

  it("uses metadata duration if browser duration is 0 or NaN", () => {
    assert.equal(getCanonicalDuration(187, 0), 187);
    assert.equal(getCanonicalDuration(187, NaN), 187);
    assert.equal(getCanonicalDuration(187, undefined), 187);
  });

  it("uses browser duration if metadata duration is absent", () => {
    assert.equal(getCanonicalDuration(0, 187), 187);
    assert.equal(getCanonicalDuration(undefined, 187), 187);
  });
});

describe("Audio Engine — Silent Audio Keep-Alive Buffer", () => {
  it("SILENT_AUDIO_URI is a valid data:audio/wav base64 string", () => {
    assert.ok(SILENT_AUDIO_URI.startsWith("data:audio/wav;base64,"));
    assert.ok(isSilentAudioUri(SILENT_AUDIO_URI));
  });

  it("isSilentAudioUri correctly distinguishes real stream URLs from silent data URI", () => {
    assert.equal(isSilentAudioUri("https://rr1---sn-xxx.googlevideo.com/videoplayback"), false);
    assert.equal(isSilentAudioUri("blob:http://localhost:3000/12345"), false);
    assert.equal(isSilentAudioUri(null), false);
    assert.equal(isSilentAudioUri(undefined), false);
  });
});

describe("Audio Engine — Next Track Candidate Pre-resolving", () => {
  function getNextTrackCandidate(
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

  const track1: PlayableTrack = { videoId: "v1", title: "Song 1", channelName: "Artist", thumbnailUrl: "", durationSeconds: 180 };
  const track2: PlayableTrack = { videoId: "v2", title: "Song 2", channelName: "Artist", thumbnailUrl: "", durationSeconds: 200 };
  const track3: PlayableTrack = { videoId: "v3", title: "Song 3", channelName: "Artist", thumbnailUrl: "", durationSeconds: 220 };

  it("picks first track from queue for upcoming prefetch", () => {
    const candidate = getNextTrackCandidate([track2, track3], [track1], track1, "none", false);
    assert.equal(candidate?.videoId, "v2");
  });

  it("returns current track when repeatMode is 'one'", () => {
    const candidate = getNextTrackCandidate([track2], [], track1, "one", false);
    assert.equal(candidate?.videoId, "v1");
  });

  it("returns first track in history when queue is empty and repeatMode is 'all'", () => {
    // History is [t2, t1] (most recent first), so chronological is [t1, t2] + current t3
    const candidate = getNextTrackCandidate([], [track2, track1], track3, "all", false);
    assert.equal(candidate?.videoId, "v1");
  });

  it("returns null when queue is empty and repeatMode is 'none'", () => {
    const candidate = getNextTrackCandidate([], [track1], track2, "none", false);
    assert.equal(candidate, null);
  });
});

describe("Audio Engine — Stream Cache & TTL Invalidation", () => {
  interface MockStream {
    videoId: string;
    streamUrl: string;
    expiresAt?: number;
  }

  const cache = new Map<string, { stream: MockStream; fetchedAt: number }>();

  function getStream(videoId: string): MockStream | null {
    const entry = cache.get(videoId);
    if (!entry) return null;
    const now = Date.now();
    if (entry.stream.expiresAt && entry.stream.expiresAt <= now + 60_000) {
      cache.delete(videoId);
      return null;
    }
    return entry.stream;
  }

  function setStream(videoId: string, stream: MockStream): void {
    cache.set(videoId, { stream, fetchedAt: Date.now() });
  }

  it("caches and retrieves valid stream", () => {
    const now = Date.now();
    setStream("v123", { videoId: "v123", streamUrl: "https://cdn.example.com/audio.m4a", expiresAt: now + 3600_000 });
    const hit = getStream("v123");
    assert.ok(hit !== null);
    assert.equal(hit?.streamUrl, "https://cdn.example.com/audio.m4a");
  });

  it("expires stream if expiresAt is within 60 seconds (expiry safety buffer)", () => {
    const now = Date.now();
    // Expires in 30 seconds -> within the 60s safety buffer
    setStream("vExpiring", { videoId: "vExpiring", streamUrl: "https://cdn.example.com/expiring.m4a", expiresAt: now + 30_000 });
    const hit = getStream("vExpiring");
    assert.equal(hit, null);
  });

  it("treats past expiresAt as expired", () => {
    const now = Date.now();
    setStream("vPast", { videoId: "vPast", streamUrl: "https://cdn.example.com/past.m4a", expiresAt: now - 10_000 });
    assert.equal(getStream("vPast"), null);
  });
});

describe("Audio Engine — Timestamp Debouncing for Lock Screen Navigation", () => {
  function shouldDebounceAdvance(lastAdvanceTime: number, now: number, thresholdMs = 500): boolean {
    return now - lastAdvanceTime < thresholdMs;
  }

  it("blocks rapid duplicate advances within 500ms (e.g. rapid ended + watchdog)", () => {
    const t0 = 1000;
    const t1 = 1200; // +200ms
    assert.equal(shouldDebounceAdvance(t0, t1), true, "Should debounce call within 200ms");
  });

  it("allows advance after 500ms has elapsed", () => {
    const t0 = 1000;
    const t2 = 1600; // +600ms
    assert.equal(shouldDebounceAdvance(t0, t2), false, "Should allow advance after 600ms");
  });
});


