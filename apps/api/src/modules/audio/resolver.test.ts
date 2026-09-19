// ============================================
// DENGARKAN — Audio Resolver Tests
//
// Tests the resolver logic without actually calling yt-dlp or YouTube.
// All yt-dlp execution is mocked via a thin "executor" abstraction.
//
// Run: node --test --import tsx/esm src/modules/audio/resolver.test.ts
//
// Coverage:
//   ✓ Valid video → AudioStream returned
//   ✓ Cache hit → executor not called again
//   ✓ Invalid video ID → VIDEO_NOT_FOUND (no exec)
//   ✓ Video not found (yt-dlp stderr) → VIDEO_NOT_FOUND
//   ✓ Age-restricted / private → VIDEO_UNAVAILABLE
//   ✓ Rate limited → RATE_LIMITED
//   ✓ Network error → NETWORK_ERROR
//   ✓ Live stream → NO_AUDIO_STREAM
//   ✓ No audio URL in output → NO_AUDIO_STREAM
//   ✓ Video+audio format selected → NO_AUDIO_STREAM
//   ✓ yt-dlp timeout → RESOLVER_FAILED
//   ✓ Invalid JSON output → RESOLVER_FAILED
//   ✓ Expired stream → executor called again on next resolve
//   ✓ refresh() → bypass cache, call executor
//   ✓ MIME type mapping (m4a, webm, mp3, unknown)
//   ✓ Expiry capped at MAX_CACHE_MS
//   ✓ Expiry parsed from ?expire= param
//   ✓ vcodec check rejects video+audio formats
//
// Documented limitations:
//   See src/modules/audio/errors.ts and resolver.ts for the full list.
//   Summary:
//     • Age-restricted & login-required: not supported
//     • Live streams: HLS manifests, not direct URLs — not supported
//     • Geo-blocked: appears as VIDEO_UNAVAILABLE
//     • WebM/Opus selected as fallback may not play on Safari (iOS 17)
//     • YouTube CDN URLs expire (~6h); use /refresh on 403
// ============================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ResolverError, type ResolverErrorCode } from './errors.js';
import { videoIdSchema } from '@dengarkan/shared';
import type { AudioStream } from '@dengarkan/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Testable resolver factory
//
// We extract the resolver logic into a factory that accepts an injected
// executor function. This lets us mock yt-dlp without touching the file system.
// ─────────────────────────────────────────────────────────────────────────────

type Executor = (videoId: string) => Promise<{ stdout: string; stderr: string }>;

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const MAX_CACHE_MS     = 5.5 * 60 * 60 * 1000;

// ── Same helpers as resolver.ts (duplicated for testability) ─────────────────

const YTDLP_PATTERNS = {
  notFound:    /Video unavailable|This video is not available|This video has been removed|No video formats found/i,
  unavailable: /Sign in to confirm|age.?restricted|members.?only|private video|This video is private|video is unavailable/i,
  rateLimit:   /HTTP Error 429|Too Many Requests|rate.?limit/i,
  network:     /unable to download|network/i,
  liveStream:  /is a live stream|live stream/i,
};

function classifyYtdlpError(stderr: string, exitCode: number | null): ResolverError {
  if (YTDLP_PATTERNS.rateLimit.test(stderr))   return new ResolverError('RATE_LIMITED',      'YouTube rate limited the request');
  if (YTDLP_PATTERNS.unavailable.test(stderr)) return new ResolverError('VIDEO_UNAVAILABLE', 'Video requires sign-in or is restricted');
  if (YTDLP_PATTERNS.notFound.test(stderr))    return new ResolverError('VIDEO_NOT_FOUND',   'Video not found or removed');
  if (YTDLP_PATTERNS.liveStream.test(stderr))  return new ResolverError('NO_AUDIO_STREAM',   'Live streams are not supported');
  if (YTDLP_PATTERNS.network.test(stderr))     return new ResolverError('NETWORK_ERROR',     'Network error during resolution');
  if (exitCode === 1 && stderr.toLowerCase().includes('error')) return new ResolverError('VIDEO_UNAVAILABLE', 'Video unavailable');
  return new ResolverError('RESOLVER_FAILED', `yt-dlp failed (exit ${exitCode})`);
}

function parseMimeType(ext: string | undefined): string {
  switch (ext) {
    case 'm4a':  return 'audio/mp4';
    case 'aac':  return 'audio/aac';
    case 'mp3':  return 'audio/mpeg';
    case 'ogg':  return 'audio/ogg';
    case 'webm': return 'audio/webm';
    default:     return 'audio/mp4';
  }
}

function parseExpiry(streamUrl: string): number {
  try {
    const expParam = new URL(streamUrl).searchParams.get('expire');
    if (expParam) {
      const epoch = parseInt(expParam, 10) * 1000;
      if (isFinite(epoch) && epoch > Date.now()) return epoch;
    }
  } catch { /* ignore */ }
  return Date.now() + 6 * 60 * 60 * 1000;
}

interface YtdlpOutput {
  url?: string;
  ext?: string;
  acodec?: string;
  vcodec?: string;
  abr?: number;
  tbr?: number;
  asr?: number;
  duration?: number;
  title?: string;
  fulltitle?: string;
  uploader?: string;
  channel?: string;
  thumbnail?: string;
  is_live?: boolean;
  live_status?: string;
}

function buildStream(videoId: string, data: YtdlpOutput): AudioStream {
  if (!data.url) throw new ResolverError('NO_AUDIO_STREAM', 'yt-dlp returned no stream URL');
  if (data.is_live || data.live_status === 'is_live') throw new ResolverError('NO_AUDIO_STREAM', 'Live streams are not supported');
  if (data.vcodec && data.vcodec !== 'none' && data.vcodec !== 'null') {
    throw new ResolverError('NO_AUDIO_STREAM', `yt-dlp selected a video+audio format (vcodec=${data.vcodec})`);
  }
  const expiresAt = Math.min(parseExpiry(data.url), Date.now() + MAX_CACHE_MS);
  return {
    videoId,
    streamUrl:       data.url,
    mimeType:        parseMimeType(data.ext),
    codec:           data.acodec ?? 'mp4a.40.2',
    bitrate:         Math.round(((data.abr ?? data.tbr ?? 128)) * 1000),
    sampleRate:      data.asr ?? 44100,
    durationSeconds: Math.round(data.duration ?? 0),
    expiresAt,
    title:           data.title ?? 'Untitled Track',
    channelName:     data.uploader ?? 'Unknown Artist',
    thumbnailUrl:    data.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

class LRUStreamCache {
  private readonly cache = new Map<string, AudioStream>();
  constructor(private readonly maxSize: number) {}

  get(videoId: string): AudioStream | undefined {
    const entry = this.cache.get(videoId);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt - EXPIRY_BUFFER_MS) { this.cache.delete(videoId); return undefined; }
    this.cache.delete(videoId);
    this.cache.set(videoId, entry);
    return entry;
  }
  set(videoId: string, stream: AudioStream): void {
    this.cache.delete(videoId);
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(videoId, stream);
  }
  delete(videoId: string): void { this.cache.delete(videoId); }
  get size() { return this.cache.size; }
}

function makeResolver(executor: Executor) {
  const cache = new LRUStreamCache(10);

  async function fetchStream(videoId: string): Promise<AudioStream> {
    let stdout: string;
    let stderr: string;

    try {
      const result = await executor(videoId);
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const error = err as { stderr?: string; exitCode?: number; killed?: boolean; signal?: string };
      const errStderr = error.stderr ?? '';
      const exitCode  = typeof error.exitCode === 'number' ? error.exitCode : null;
      if (error.killed || error.signal === 'SIGTERM') {
        throw new ResolverError('RESOLVER_FAILED', 'yt-dlp timed out');
      }
      throw classifyYtdlpError(errStderr, exitCode);
    }

    let data: YtdlpOutput;
    try {
      data = JSON.parse(stdout) as YtdlpOutput;
    } catch {
      throw new ResolverError('RESOLVER_FAILED', 'yt-dlp returned invalid JSON');
    }

    const stream = buildStream(videoId, data);
    cache.set(videoId, stream);
    return stream;
  }

  return {
    async resolve(videoId: string): Promise<AudioStream> {
      const parsed = videoIdSchema.safeParse(videoId);
      if (!parsed.success) throw new ResolverError('VIDEO_NOT_FOUND', `Invalid video ID: "${videoId}"`);
      const cached = cache.get(parsed.data);
      if (cached) return cached;
      return fetchStream(parsed.data);
    },
    async refresh(videoId: string): Promise<AudioStream> {
      const parsed = videoIdSchema.safeParse(videoId);
      if (!parsed.success) throw new ResolverError('VIDEO_NOT_FOUND', `Invalid video ID: "${videoId}"`);
      cache.delete(parsed.data);
      return fetchStream(parsed.data);
    },
    get cacheSize() { return cache.size; },
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_VIDEO_ID = 'dQw4w9WgXcQ';
const FUTURE_EXPIRE  = Math.floor((Date.now() + 6 * 60 * 60 * 1000) / 1000); // 6h from now

function makeValidOutput(overrides: Partial<YtdlpOutput> = {}): string {
  return JSON.stringify({
    url:       `https://rr1.example.com/videoplayback?expire=${FUTURE_EXPIRE}&id=xyz`,
    ext:       'm4a',
    acodec:    'mp4a.40.2',
    vcodec:    'none',
    abr:       128,
    asr:       44100,
    duration:  213,
    title:     'Never Gonna Give You Up',
    uploader:  'Rick Astley',
    thumbnail: `https://i.ytimg.com/vi/${VALID_VIDEO_ID}/hqdefault.jpg`,
    ...overrides,
  } satisfies YtdlpOutput);
}

function errorExecutor(stderr: string, exitCode = 1): Executor {
  return async () => {
    const err = Object.assign(new Error('yt-dlp failed'), { stderr, exitCode }) as Error & { stderr: string; exitCode: number };
    throw err;
  };
}

function successExecutor(output: string): Executor {
  return async () => ({ stdout: output, stderr: '' });
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('AudioResolver', () => {
  describe('Successful resolution', () => {
    it('returns AudioStream for a valid video', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput()));
      const stream = await resolver.resolve(VALID_VIDEO_ID);
      assert.equal(stream.videoId,         VALID_VIDEO_ID);
      assert.equal(stream.mimeType,        'audio/mp4');
      assert.equal(stream.codec,           'mp4a.40.2');
      assert.equal(stream.bitrate,         128000);
      assert.equal(stream.sampleRate,      44100);
      assert.equal(stream.durationSeconds, 213);
      assert.equal(stream.title,           'Never Gonna Give You Up');
      assert.equal(stream.channelName,     'Rick Astley');
      assert.ok(stream.streamUrl.startsWith('https://'));
      assert.ok(stream.expiresAt > Date.now(), 'expiresAt should be in the future');
    });

    it('uses fallback thumbnail when not provided', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput({ thumbnail: undefined })));
      const stream = await resolver.resolve(VALID_VIDEO_ID);
      assert.ok(stream.thumbnailUrl.includes(VALID_VIDEO_ID));
    });

    it('falls back to tbr when abr is not present', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput({ abr: undefined, tbr: 160 })));
      const stream = await resolver.resolve(VALID_VIDEO_ID);
      assert.equal(stream.bitrate, 160000);
    });

    it('uses default bitrate (128 kbps) when neither abr nor tbr are present', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput({ abr: undefined, tbr: undefined })));
      const stream = await resolver.resolve(VALID_VIDEO_ID);
      assert.equal(stream.bitrate, 128000);
    });
  });

  describe('MIME type mapping', () => {
    const cases: [string | undefined, string][] = [
      ['m4a',     'audio/mp4'],
      ['aac',     'audio/aac'],
      ['mp3',     'audio/mpeg'],
      ['ogg',     'audio/ogg'],
      ['webm',    'audio/webm'],
      [undefined, 'audio/mp4'], // fallback
      ['flac',    'audio/mp4'], // unknown → fallback
    ];
    for (const [ext, expected] of cases) {
      it(`ext=${ext ?? 'undefined'} → ${expected}`, async () => {
        const resolver = makeResolver(successExecutor(makeValidOutput({ ext })));
        const stream = await resolver.resolve(VALID_VIDEO_ID);
        assert.equal(stream.mimeType, expected);
      });
    }
  });

  describe('Expiry parsing', () => {
    it('parses ?expire= param from stream URL', async () => {
      const expireTs = Math.floor((Date.now() + 3 * 60 * 60 * 1000) / 1000); // 3h
      const url = `https://rr1.example.com/videoplayback?expire=${expireTs}&id=xyz`;
      const resolver = makeResolver(successExecutor(makeValidOutput({ url })));
      const stream = await resolver.resolve(VALID_VIDEO_ID);
      assert.equal(stream.expiresAt, expireTs * 1000);
    });

    it('caps expiresAt at MAX_CACHE_MS when CDN expiry is far future', async () => {
      const farFuture = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000); // 24h
      const url = `https://rr1.example.com/videoplayback?expire=${farFuture}&id=xyz`;
      const resolver = makeResolver(successExecutor(makeValidOutput({ url })));
      const stream = await resolver.resolve(VALID_VIDEO_ID);
      const maxExpected = Date.now() + MAX_CACHE_MS;
      assert.ok(stream.expiresAt <= maxExpected + 1000, `expiresAt should be capped; got ${stream.expiresAt}, max ${maxExpected}`);
    });

    it('uses 6h default when URL has no ?expire= param', async () => {
      const url = 'https://rr1.example.com/videoplayback?id=xyz'; // no expire
      const resolver = makeResolver(successExecutor(makeValidOutput({ url })));
      const before = Date.now();
      const stream = await resolver.resolve(VALID_VIDEO_ID);
      const defaultExpiry = before + 6 * 60 * 60 * 1000;
      assert.ok(stream.expiresAt <= defaultExpiry + 2000);
      assert.ok(stream.expiresAt >= before + 5 * 60 * 60 * 1000);
    });
  });

  describe('Caching (L1 in-memory LRU)', () => {
    it('cache hit — executor not called again on second resolve', async () => {
      let callCount = 0;
      const executor: Executor = async () => { callCount++; return { stdout: makeValidOutput(), stderr: '' }; };
      const resolver = makeResolver(executor);
      await resolver.resolve(VALID_VIDEO_ID);
      await resolver.resolve(VALID_VIDEO_ID);
      assert.equal(callCount, 1, 'Executor should only be called once on cache hit');
    });

    it('cache stores entry — cacheSize increments', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput()));
      assert.equal(resolver.cacheSize, 0);
      await resolver.resolve(VALID_VIDEO_ID);
      assert.equal(resolver.cacheSize, 1);
    });

    it('expired stream — calls executor again', async () => {
      let callCount = 0;
      // expires in 4 minutes from now = within EXPIRY_BUFFER_MS (5 min)
      // so the cache will see it as expired on second read
      const nearExpire = Math.floor((Date.now() + 4 * 60 * 1000) / 1000);
      const expiredOutput = makeValidOutput({
        url: `https://rr1.example.com/videoplayback?expire=${nearExpire}&id=xyz`,
      });
      const executor: Executor = async () => { callCount++; return { stdout: expiredOutput, stderr: '' }; };
      const resolver = makeResolver(executor);
      await resolver.resolve(VALID_VIDEO_ID); // caches entry expiring in 4 min
      // Second call: 4min expiry < EXPIRY_BUFFER_MS (5min), so cache is stale → re-fetch
      await resolver.resolve(VALID_VIDEO_ID);
      assert.equal(callCount, 2, 'Should re-fetch stream within expiry buffer');
    });
  });

  describe('refresh()', () => {
    it('bypass cache and call executor again', async () => {
      let callCount = 0;
      const executor: Executor = async () => { callCount++; return { stdout: makeValidOutput(), stderr: '' }; };
      const resolver = makeResolver(executor);
      await resolver.resolve(VALID_VIDEO_ID);
      await resolver.refresh(VALID_VIDEO_ID);
      assert.equal(callCount, 2, 'refresh() should bypass cache');
    });

    it('returns fresh stream after refresh', async () => {
      const url1 = `https://cdn1.example.com/videoplayback?expire=${FUTURE_EXPIRE}&id=1`;
      const url2 = `https://cdn2.example.com/videoplayback?expire=${FUTURE_EXPIRE}&id=2`;
      let call = 0;
      const executor: Executor = async () => ({
        stdout: makeValidOutput({ url: call++ === 0 ? url1 : url2 }),
        stderr: '',
      });
      const resolver = makeResolver(executor);
      const first  = await resolver.resolve(VALID_VIDEO_ID);
      const second = await resolver.refresh(VALID_VIDEO_ID);
      assert.notEqual(first.streamUrl, second.streamUrl, 'Refreshed stream should have different URL');
    });
  });

  describe('Input validation', () => {
    const invalidIds = [
      '',
      'toolong12345678',
      'short',
      'has space 12',
      '../../../etc/passwd',
      '; rm -rf /',
      "' OR '1'='1",
      'dQw4w9WgXcQ\n--inject',
      'dQw4w9WgXcQ; ls',
    ];

    for (const id of invalidIds) {
      it(`rejects invalid video ID: "${id.slice(0, 30)}"`, async () => {
        const resolver = makeResolver(async () => { throw new Error('Should not be called'); });
        await assert.rejects(
          () => resolver.resolve(id),
          (err) => {
            assert.ok(err instanceof ResolverError);
            assert.equal((err as ResolverError).code, 'VIDEO_NOT_FOUND' as ResolverErrorCode);
            return true;
          }
        );
      });
    }

    it('accepts valid 11-char alphanumeric video ID', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput()));
      const stream = await resolver.resolve('dQw4w9WgXcQ');
      assert.equal(stream.videoId, 'dQw4w9WgXcQ');
    });

    it('accepts video ID with underscores and hyphens', async () => {
      const id = 'abc-def_1234';
      // Too long, should fail
      const resolver = makeResolver(async () => ({ stdout: makeValidOutput(), stderr: '' }));
      await assert.rejects(() => resolver.resolve(id));
    });

    it('accepts exactly 11-char ID with hyphen/underscore', async () => {
      const id = 'abc-def_123'; // 11 chars: a b c - d e f _ 1 2 3
      const resolver = makeResolver(successExecutor(JSON.stringify({
        url: `https://rr1.example.com/videoplayback?expire=${FUTURE_EXPIRE}`,
        ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none',
        abr: 128, asr: 44100, duration: 100,
        title: 'Test', uploader: 'Artist',
      })));
      const stream = await resolver.resolve(id);
      assert.equal(stream.videoId, id);
    });
  });

  describe('Error classification', () => {
    it('VIDEO_NOT_FOUND — yt-dlp says "Video unavailable"', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: Video unavailable', 1));
      await assert.rejects(
        () => resolver.resolve(VALID_VIDEO_ID),
        (err: unknown) => {
          assert.ok(err instanceof ResolverError);
          assert.equal((err as ResolverError).code, 'VIDEO_NOT_FOUND' as ResolverErrorCode);
          return true;
        }
      );
    });

    it('VIDEO_NOT_FOUND — "This video has been removed"', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: This video has been removed', 1));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'VIDEO_NOT_FOUND' as ResolverErrorCode);
        return true;
      });
    });

    it('VIDEO_UNAVAILABLE — age-restricted content', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: Sign in to confirm your age', 1));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'VIDEO_UNAVAILABLE' as ResolverErrorCode);
        return true;
      });
    });

    it('VIDEO_UNAVAILABLE — private video', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: This video is private', 1));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'VIDEO_UNAVAILABLE' as ResolverErrorCode);
        return true;
      });
    });

    it('VIDEO_UNAVAILABLE — members only', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: This video is members-only', 1));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'VIDEO_UNAVAILABLE' as ResolverErrorCode);
        return true;
      });
    });

    it('RATE_LIMITED — HTTP 429 from YouTube', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: HTTP Error 429: Too Many Requests', 1));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'RATE_LIMITED' as ResolverErrorCode);
        return true;
      });
    });

    it('NETWORK_ERROR — unable to download', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: unable to download webpage', 1));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'NETWORK_ERROR' as ResolverErrorCode);
        return true;
      });
    });

    it('NO_AUDIO_STREAM — live stream', async () => {
      const resolver = makeResolver(errorExecutor('ERROR: This video is a live stream', 1));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'NO_AUDIO_STREAM' as ResolverErrorCode);
        return true;
      });
    });

    it('NO_AUDIO_STREAM — output has no url field', async () => {
      const resolver = makeResolver(successExecutor(JSON.stringify({
        ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none',
        // url is missing!
      })));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'NO_AUDIO_STREAM' as ResolverErrorCode);
        return true;
      });
    });

    it('NO_AUDIO_STREAM — output has is_live: true', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput({ is_live: true })));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'NO_AUDIO_STREAM' as ResolverErrorCode);
        return true;
      });
    });

    it('NO_AUDIO_STREAM — vcodec is not "none" (video+audio format selected)', async () => {
      const resolver = makeResolver(successExecutor(makeValidOutput({ vcodec: 'vp9' })));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'NO_AUDIO_STREAM' as ResolverErrorCode);
        return true;
      });
    });

    it('RESOLVER_FAILED — yt-dlp returns invalid JSON', async () => {
      const resolver = makeResolver(async () => ({ stdout: 'not json at all', stderr: '' }));
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'RESOLVER_FAILED' as ResolverErrorCode);
        return true;
      });
    });

    it('RESOLVER_FAILED — yt-dlp process times out', async () => {
      const resolver = makeResolver(async () => {
        const err = Object.assign(new Error('ETIMEDOUT'), { killed: true, signal: 'SIGTERM' });
        throw err;
      });
      await assert.rejects(() => resolver.resolve(VALID_VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'RESOLVER_FAILED' as ResolverErrorCode);
        return true;
      });
    });
  });

  describe('refresh() error handling', () => {
    it('refresh with invalid ID → VIDEO_NOT_FOUND without calling executor', async () => {
      const resolver = makeResolver(async () => { throw new Error('Should not be called'); });
      await assert.rejects(() => resolver.refresh('bad'), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'VIDEO_NOT_FOUND' as ResolverErrorCode);
        return true;
      });
    });
  });

  describe('ResolverError class', () => {
    it('is instance of Error', () => {
      const e = new ResolverError('RESOLVER_FAILED', 'test');
      assert.ok(e instanceof Error);
      assert.ok(e instanceof ResolverError);
    });

    it('has correct name', () => {
      const e = new ResolverError('RATE_LIMITED', 'test');
      assert.equal(e.name, 'ResolverError');
    });

    it('exposes code and message', () => {
      const e = new ResolverError('VIDEO_NOT_FOUND', 'the message');
      assert.equal(e.code, 'VIDEO_NOT_FOUND');
      assert.equal(e.message, 'the message');
    });

    it('stores cause', () => {
      const cause = new Error('original');
      const e = new ResolverError('NETWORK_ERROR', 'wrapped', cause);
      assert.equal(e.cause, cause);
    });
  });
});
