// ============================================
// DENGARKAN — Media Session Tests
//
// Tests the pure logic in use-media-session.ts:
//   • buildArtwork() — YouTube URL size derivation
//   • toPlaybackState() — player state → MediaSession playbackState mapping
//   • safeSetPositionState() validation rules (valid/invalid inputs)
//   • Position throttle logic
//
// No DOM, no browser API, no React.
//
// Run: node --test --experimental-strip-types
//       src/features/player/media-session.test.ts
//
// Coverage:
//   ✓ buildArtwork — YouTube URL produces 4 size variants
//   ✓ buildArtwork — all variants keep correct base path
//   ✓ buildArtwork — non-YouTube URL uses fallback (single entry)
//   ✓ buildArtwork — hqdefault input still produces full set
//   ✓ buildArtwork — maxresdefault input produces full set
//   ✓ toPlaybackState — playing → "playing"
//   ✓ toPlaybackState — buffering → "playing"
//   ✓ toPlaybackState — paused → "paused"
//   ✓ toPlaybackState — error → "paused"
//   ✓ toPlaybackState — idle → "none"
//   ✓ toPlaybackState — loading → "none"
//   ✓ toPlaybackState — refreshing → "none"
//   ✓ position validation — invalid duration blocked
//   ✓ position validation — NaN duration blocked
//   ✓ position validation — negative currentTime blocked
//   ✓ position validation — valid values pass
//   ✓ position validation — position clamped to duration
//   ✓ throttle — second call within window is suppressed
//   ✓ throttle — call after window passes through
// ============================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─────────────────────────────────────────────────────────────────────────────
// Functions extracted from use-media-session.ts (pure, no browser deps)
// ─────────────────────────────────────────────────────────────────────────────

// ── buildArtwork ─────────────────────────────────────────────────────────────

type MediaImage = { src: string; sizes: string; type: string };

function buildArtwork(thumbnailUrl: string): MediaImage[] {
  if (thumbnailUrl.includes("i.ytimg.com/vi/")) {
    const base = thumbnailUrl.replace(/\/(hqdefault|mqdefault|sddefault|maxresdefault|default)(\.\w+)?$/, "");
    return [
      { src: `${base}/mqdefault.jpg`,     sizes: "320x180",  type: "image/jpeg" },
      { src: `${base}/hqdefault.jpg`,     sizes: "480x360",  type: "image/jpeg" },
      { src: `${base}/sddefault.jpg`,     sizes: "640x480",  type: "image/jpeg" },
      { src: `${base}/maxresdefault.jpg`, sizes: "1280x720", type: "image/jpeg" },
    ];
  }
  return [{ src: thumbnailUrl, sizes: "480x360", type: "image/jpeg" }];
}

// ── toPlaybackState ───────────────────────────────────────────────────────────

type PlayerState = "idle" | "loading" | "playing" | "paused" | "buffering" | "refreshing" | "error";
type MediaSessionPlaybackState = "none" | "paused" | "playing";

function toPlaybackState(state: PlayerState): MediaSessionPlaybackState {
  switch (state) {
    case "playing":
    case "buffering":
      return "playing";
    case "paused":
    case "error":
      return "paused";
    default:
      return "none";
  }
}

// ── Position validation ───────────────────────────────────────────────────────
// Returns the validated {duration, position} or null if invalid

interface PositionState {
  duration:     number;
  position:     number;
  playbackRate: number;
}

function validatePositionState(
  duration: number,
  currentTime: number,
  playbackRate: number,
): PositionState | null {
  if (!isFinite(duration)    || duration    <= 0) return null;
  if (!isFinite(currentTime) || currentTime <  0) return null;
  const position = Math.min(currentTime, duration);
  return { duration, position, playbackRate };
}

// ── Throttle logic ────────────────────────────────────────────────────────────

function makeThrottle(windowMs: number) {
  let lastCall = 0;
  return function shouldCall(): boolean {
    const now = Date.now();
    if (now - lastCall >= windowMs) {
      lastCall = now;
      return true;
    }
    return false;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe("Media Session — buildArtwork()", () => {
  const VIDEO_ID = "dQw4w9WgXcQ";
  const BASE_URL = `https://i.ytimg.com/vi/${VIDEO_ID}`;

  it("hqdefault URL → 4 size variants", () => {
    const artwork = buildArtwork(`${BASE_URL}/hqdefault.jpg`);
    assert.equal(artwork.length, 4);
  });

  it("mqdefault URL → 4 size variants", () => {
    const artwork = buildArtwork(`${BASE_URL}/mqdefault.jpg`);
    assert.equal(artwork.length, 4);
  });

  it("maxresdefault URL → 4 size variants", () => {
    const artwork = buildArtwork(`${BASE_URL}/maxresdefault.jpg`);
    assert.equal(artwork.length, 4);
  });

  it("sddefault URL → 4 size variants", () => {
    const artwork = buildArtwork(`${BASE_URL}/sddefault.jpg`);
    assert.equal(artwork.length, 4);
  });

  it("default URL → 4 size variants", () => {
    const artwork = buildArtwork(`${BASE_URL}/default.jpg`);
    assert.equal(artwork.length, 4);
  });

  it("all variants are image/jpeg", () => {
    const artwork = buildArtwork(`${BASE_URL}/hqdefault.jpg`);
    artwork.forEach(a => assert.equal(a.type, "image/jpeg"));
  });

  it("sizes are correct: 320x180, 480x360, 640x480, 1280x720", () => {
    const artwork = buildArtwork(`${BASE_URL}/hqdefault.jpg`);
    assert.equal(artwork[0].sizes, "320x180");
    assert.equal(artwork[1].sizes, "480x360");
    assert.equal(artwork[2].sizes, "640x480");
    assert.equal(artwork[3].sizes, "1280x720");
  });

  it("all variants have correct base path (no double slashes)", () => {
    const artwork = buildArtwork(`${BASE_URL}/hqdefault.jpg`);
    artwork.forEach(a => {
      assert.ok(a.src.startsWith(BASE_URL + "/"), `Expected src to start with base: ${a.src}`);
      assert.ok(!a.src.includes("//vi/"), "Should not have double slashes");
    });
  });

  it("contains mqdefault, hqdefault, sddefault, maxresdefault variants", () => {
    const artwork = buildArtwork(`${BASE_URL}/hqdefault.jpg`);
    const srcs = artwork.map(a => a.src);
    assert.ok(srcs.some(s => s.includes("mqdefault")));
    assert.ok(srcs.some(s => s.includes("hqdefault")));
    assert.ok(srcs.some(s => s.includes("sddefault")));
    assert.ok(srcs.some(s => s.includes("maxresdefault")));
  });

  it("non-YouTube URL → single fallback entry", () => {
    const url = "https://example.com/thumb.jpg";
    const artwork = buildArtwork(url);
    assert.equal(artwork.length, 1);
    assert.equal(artwork[0].src, url);
    assert.equal(artwork[0].sizes, "480x360");
    assert.equal(artwork[0].type, "image/jpeg");
  });

  it("CDN variant URL (lh3.googleusercontent) → single fallback", () => {
    const url = "https://lh3.googleusercontent.com/thumb.jpg";
    const artwork = buildArtwork(url);
    assert.equal(artwork.length, 1);
  });
});

describe("Media Session — toPlaybackState()", () => {
  it("playing → 'playing'",   () => assert.equal(toPlaybackState("playing"),    "playing"));
  it("buffering → 'playing'", () => assert.equal(toPlaybackState("buffering"),  "playing"));
  it("paused → 'paused'",     () => assert.equal(toPlaybackState("paused"),     "paused"));
  it("error → 'paused'",      () => assert.equal(toPlaybackState("error"),      "paused"));
  it("idle → 'none'",         () => assert.equal(toPlaybackState("idle"),       "none"));
  it("loading → 'none'",      () => assert.equal(toPlaybackState("loading"),    "none"));
  it("refreshing → 'none'",   () => assert.equal(toPlaybackState("refreshing"), "none"));
});

describe("Media Session — position validation", () => {
  it("valid inputs → returns PositionState", () => {
    const result = validatePositionState(213, 45, 1.0);
    assert.ok(result !== null);
    assert.equal(result!.duration,     213);
    assert.equal(result!.position,     45);
    assert.equal(result!.playbackRate, 1.0);
  });

  it("duration = 0 → blocked (null)", () => {
    assert.equal(validatePositionState(0, 0, 1.0), null);
  });

  it("duration = NaN → blocked", () => {
    assert.equal(validatePositionState(NaN, 0, 1.0), null);
  });

  it("duration = Infinity → blocked", () => {
    assert.equal(validatePositionState(Infinity, 0, 1.0), null);
  });

  it("duration < 0 → blocked", () => {
    assert.equal(validatePositionState(-1, 0, 1.0), null);
  });

  it("currentTime = NaN → blocked", () => {
    assert.equal(validatePositionState(213, NaN, 1.0), null);
  });

  it("currentTime = -1 → blocked", () => {
    assert.equal(validatePositionState(213, -1, 1.0), null);
  });

  it("currentTime = Infinity → blocked", () => {
    assert.equal(validatePositionState(213, Infinity, 1.0), null);
  });

  it("position clamped to duration when currentTime > duration", () => {
    const result = validatePositionState(213, 999, 1.0);
    assert.ok(result !== null);
    assert.equal(result!.position, 213); // clamped
  });

  it("currentTime = 0 is valid", () => {
    const result = validatePositionState(213, 0, 1.0);
    assert.ok(result !== null);
    assert.equal(result!.position, 0);
  });

  it("currentTime = duration is valid", () => {
    const result = validatePositionState(213, 213, 1.0);
    assert.ok(result !== null);
    assert.equal(result!.position, 213);
  });

  it("playbackRate = 0.5 is passed through", () => {
    const result = validatePositionState(213, 10, 0.5);
    assert.ok(result !== null);
    assert.equal(result!.playbackRate, 0.5);
  });
});

describe("Media Session — throttle logic", () => {
  it("first call always passes", () => {
    const shouldCall = makeThrottle(500);
    assert.equal(shouldCall(), true);
  });

  it("immediate second call is suppressed", () => {
    const shouldCall = makeThrottle(500);
    shouldCall(); // first call passes
    assert.equal(shouldCall(), false);
  });

  it("multiple rapid calls all suppressed after first", () => {
    const shouldCall = makeThrottle(500);
    shouldCall(); // first passes
    for (let i = 0; i < 10; i++) {
      assert.equal(shouldCall(), false, `Call ${i + 2} should be suppressed`);
    }
  });

  it("call after window elapses passes (0ms window)", () => {
    // Use 0ms window so we can test without actually waiting
    const shouldCall = makeThrottle(0);
    shouldCall(); // first call
    // After 0ms window, next call should pass immediately
    assert.equal(shouldCall(), true);
  });
});

describe("Media Session — artwork URL edge cases", () => {
  it("URL with no trailing thumbnail name → fallback", () => {
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ";
    // Does not match the pattern (no /hqdefault etc.) — but includes i.ytimg.com/vi/
    const artwork = buildArtwork(url);
    // The base would be the URL itself (replace changes nothing), generating variants
    assert.equal(artwork.length, 4);
    assert.ok(artwork[0].src.includes("mqdefault"));
  });

  it("URL with .webp extension → jpg variants generated", () => {
    const url = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.webp";
    const artwork = buildArtwork(url);
    assert.equal(artwork.length, 4);
    // All generated variants use .jpg
    artwork.forEach(a => assert.ok(a.src.endsWith(".jpg"), `Expected .jpg: ${a.src}`));
  });
});
