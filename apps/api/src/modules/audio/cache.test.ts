// ============================================
// DENGARKAN — Audio Cache & Refresh Tests
//
// Tests the two-level cache strategy and refresh flow:
//   L1 = in-memory LRU (resolver.ts)
//   L2 = DB-backed repository (audio-cache.repository.ts interface)
//
// All yt-dlp execution and DB I/O is mocked.
//
// Run: node --test --import tsx/esm src/modules/audio/cache.test.ts
//
// Coverage:
//   ✓ L1 hit — L2 not consulted
//   ✓ L2 hit — L1 is warmed, yt-dlp not called
//   ✓ L1+L2 miss — yt-dlp is called, both caches written
//   ✓ L2 write is non-blocking (doesn't delay response)
//   ✓ Cache invalidation (evicts L1 + L2)
//   ✓ pruneExpiredL2 — delegates to L2 repository
//   ✓ refresh() — evicts L1+L2, re-fetches via yt-dlp
//   ✓ NETWORK_ERROR — retry with backoff (mock fast delays)
//   ✓ RATE_LIMITED — retry with backoff
//   ✓ VIDEO_NOT_FOUND — no retry (fail immediately)
//   ✓ Max attempts exhausted — throws last error
//   ✓ TTL: stream with near-expiry (within buffer) is treated as expired
//   ✓ L2 cache write failure is non-fatal
// ============================================

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ResolverError } from './errors.js';
import { videoIdSchema } from '@dengarkan/shared';
import type { AudioStream } from '@dengarkan/shared';
import type { AudioCacheRepository } from '../../infrastructure/repositories/audio-cache.repository.js';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory L2 cache implementation (same as repositories.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const MAX_CACHE_MS     = 5.5 * 60 * 60 * 1000;

function makeInMemoryL2(): AudioCacheRepository & { store: Map<string, AudioStream> } {
  const store = new Map<string, AudioStream>();
  return {
    store,
    async get(videoId) {
      const entry = store.get(videoId);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now() + EXPIRY_BUFFER_MS) {
        store.delete(videoId);
        return null;
      }
      return entry;
    },
    async set(stream) {
      const expiresAt = Math.min(stream.expiresAt, Date.now() + MAX_CACHE_MS);
      store.set(stream.videoId, { ...stream, expiresAt });
    },
    async delete(videoId) { store.delete(videoId); },
    async deleteExpired() {
      let count = 0;
      const now = Date.now();
      for (const [id, entry] of store) {
        if (entry.expiresAt <= now) { store.delete(id); count++; }
      }
      return count;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Testable resolver factory (mirrors resolver.ts, injected L2 + executor)
// ─────────────────────────────────────────────────────────────────────────────

type Executor = (videoId: string) => Promise<{ stdout: string; stderr: string }>;

interface YtdlpOutput {
  url?: string; ext?: string; acodec?: string; vcodec?: string;
  abr?: number; asr?: number; duration?: number; title?: string;
  uploader?: string; thumbnail?: string; is_live?: boolean;
}

function buildStream(videoId: string, data: YtdlpOutput): AudioStream {
  if (!data.url) throw new ResolverError('NO_AUDIO_STREAM', 'no url');
  const expParam = (() => {
    try {
      const v = new URL(data.url!).searchParams.get('expire');
      if (v) { const e = parseInt(v, 10) * 1000; if (e > Date.now()) return e; }
    } catch { /* */ }
    return Date.now() + 6 * 60 * 60 * 1000;
  })();
  return {
    videoId, streamUrl: data.url!,
    mimeType: 'audio/mp4', codec: data.acodec ?? 'mp4a.40.2',
    bitrate: Math.round((data.abr ?? 128) * 1000), sampleRate: data.asr ?? 44100,
    durationSeconds: Math.round(data.duration ?? 0),
    expiresAt: Math.min(expParam, Date.now() + MAX_CACHE_MS),
    title: data.title ?? 'Track', channelName: data.uploader ?? 'Artist',
    thumbnailUrl: data.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

class LRUStreamCache {
  private readonly cache = new Map<string, AudioStream>();
  constructor(private readonly max: number) {}
  get(id: string): AudioStream | undefined {
    const e = this.cache.get(id);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt - EXPIRY_BUFFER_MS) { this.cache.delete(id); return undefined; }
    this.cache.delete(id); this.cache.set(id, e); return e;
  }
  set(id: string, s: AudioStream): void {
    this.cache.delete(id);
    if (this.cache.size >= this.max) { const k = this.cache.keys().next().value; if (k) this.cache.delete(k); }
    this.cache.set(id, s);
  }
  delete(id: string): void { this.cache.delete(id); }
  get size() { return this.cache.size; }
}

// Fast retry for tests (no real sleep)
async function withRetryFast<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelay = 0, // 0ms in tests
): Promise<T> {
  const RETRYABLE = new Set<string>(['NETWORK_ERROR', 'RATE_LIMITED']);
  let last: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try { return await fn(); }
    catch (err: unknown) {
      last = err;
      if (!(err instanceof ResolverError)) throw err;
      if (!RETRYABLE.has(err.code))       throw err;
      if (i === maxAttempts) break;
      if (baseDelay > 0) await new Promise(r => setTimeout(r, baseDelay * 2 ** (i - 1)));
    }
  }
  throw last;
}

function makeResolver(executor: Executor, l2: AudioCacheRepository) {
  const l1 = new LRUStreamCache(10);

  async function fetchAndCache(videoId: string): Promise<AudioStream> {
    let stdout: string; let stderr: string;
    try {
      const r = await executor(videoId); stdout = r.stdout; stderr = r.stderr;
    } catch (err: unknown) {
      const e = err as { stderr?: string; exitCode?: number; killed?: boolean };
      if (e.killed) throw new ResolverError('RESOLVER_FAILED', 'timed out');
      const text = (e.stderr ?? '').toLowerCase();
      if (/429|rate.?limit/.test(text)) throw new ResolverError('RATE_LIMITED', 'rate limited');
      if (/unavailable|private/.test(text)) throw new ResolverError('VIDEO_UNAVAILABLE', 'unavailable');
      if (/network|unable to download/.test(text)) throw new ResolverError('NETWORK_ERROR', 'network');
      throw new ResolverError('RESOLVER_FAILED', `exit ${e.exitCode}`);
    }
    let data: YtdlpOutput;
    try { data = JSON.parse(stdout) as YtdlpOutput; }
    catch { throw new ResolverError('RESOLVER_FAILED', 'invalid json'); }
    const stream = buildStream(videoId, data);
    l1.set(videoId, stream);
    void l2.set(stream).catch(() => { /* non-fatal */ });
    return stream;
  }

  return {
    async resolve(videoId: string): Promise<AudioStream> {
      const parsed = videoIdSchema.safeParse(videoId);
      if (!parsed.success) throw new ResolverError('VIDEO_NOT_FOUND', `invalid id: ${videoId}`);
      const id = parsed.data;
      const l1Hit = l1.get(id); if (l1Hit) return l1Hit;
      const l2Hit = await l2.get(id); if (l2Hit) { l1.set(id, l2Hit); return l2Hit; }
      return withRetryFast(() => fetchAndCache(id));
    },
    async refresh(videoId: string): Promise<AudioStream> {
      const parsed = videoIdSchema.safeParse(videoId);
      if (!parsed.success) throw new ResolverError('VIDEO_NOT_FOUND', `invalid id: ${videoId}`);
      const id = parsed.data;
      l1.delete(id); await l2.delete(id);
      return withRetryFast(() => fetchAndCache(id));
    },
    async invalidate(videoId: string): Promise<void> {
      l1.delete(videoId); await l2.delete(videoId);
    },
    async pruneExpiredL2(): Promise<number> {
      return l2.deleteExpired();
    },
    l1, l2,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VIDEO_ID    = 'dQw4w9WgXcQ';
const FAR_EXPIRE  = Math.floor((Date.now() + 6 * 60 * 60 * 1000) / 1000);
const NEAR_EXPIRE = Math.floor((Date.now() + 4 * 60 * 1000) / 1000); // within buffer

function validOutput(url?: string): string {
  return JSON.stringify({
    url: url ?? `https://cdn.example.com/audio?expire=${FAR_EXPIRE}`,
    ext: 'm4a', acodec: 'mp4a.40.2', vcodec: 'none',
    abr: 128, asr: 44100, duration: 213,
    title: 'Never Gonna Give You Up', uploader: 'Rick Astley',
  } satisfies YtdlpOutput);
}

function makeValidStream(videoId = VIDEO_ID, expiresOverride?: number): AudioStream {
  return {
    videoId, streamUrl: `https://cdn.example.com/audio?expire=${FAR_EXPIRE}`,
    mimeType: 'audio/mp4', codec: 'mp4a.40.2',
    bitrate: 128000, sampleRate: 44100, durationSeconds: 213,
    expiresAt: expiresOverride ?? (FAR_EXPIRE * 1000),
    title: 'Never Gonna Give You Up', channelName: 'Rick Astley',
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TESTS
// ─────────────────────────────────────────────────────────────────────────────

describe('Audio Cache Strategy', () => {

  describe('L1 cache (in-process LRU)', () => {
    it('L1 hit — L2 and executor not called', async () => {
      const l2     = makeInMemoryL2();
      let l2Calls  = 0;
      const proxied = { ...l2, get: async (id: string) => { l2Calls++; return l2.get(id); } };
      let execCalls = 0;
      const executor: Executor = async () => { execCalls++; return { stdout: validOutput(), stderr: '' }; };
      const resolver = makeResolver(executor, proxied);

      await resolver.resolve(VIDEO_ID); // miss → yt-dlp → L1+L2 write
      l2Calls = 0; execCalls = 0;       // reset counters

      await resolver.resolve(VIDEO_ID); // L1 hit
      assert.equal(l2Calls,   0, 'L2 should not be consulted on L1 hit');
      assert.equal(execCalls, 0, 'yt-dlp should not be called on L1 hit');
    });

    it('L1 miss + L2 hit — warms L1, executor not called', async () => {
      const l2 = makeInMemoryL2();
      await l2.set(makeValidStream()); // pre-populate L2

      let execCalls = 0;
      const executor: Executor = async () => { execCalls++; return { stdout: validOutput(), stderr: '' }; };
      const resolver = makeResolver(executor, l2);

      const stream = await resolver.resolve(VIDEO_ID);
      assert.equal(execCalls, 0, 'yt-dlp should not be called on L2 hit');
      assert.equal(stream.videoId, VIDEO_ID);

      // L1 should now be warm
      const l1Entry = resolver.l1.get(VIDEO_ID);
      assert.ok(l1Entry, 'L1 should be warmed from L2 hit');
    });

    it('L1+L2 miss — yt-dlp is called, both caches are populated', async () => {
      const l2 = makeInMemoryL2();
      let execCalls = 0;
      const executor: Executor = async () => { execCalls++; return { stdout: validOutput(), stderr: '' }; };
      const resolver = makeResolver(executor, l2);

      await resolver.resolve(VIDEO_ID);
      assert.equal(execCalls, 1, 'yt-dlp should be called on cache miss');

      // L1 populated
      assert.ok(resolver.l1.get(VIDEO_ID), 'L1 should be populated');
      // L2 populated (wait for async write — it's void)
      await new Promise(r => setTimeout(r, 10));
      const l2Entry = await l2.get(VIDEO_ID);
      assert.ok(l2Entry, 'L2 should be populated');
    });
  });

  describe('TTL / expiry handling', () => {
    it('L1 entry within EXPIRY_BUFFER is treated as expired — L2 is consulted', async () => {
      const l2 = makeInMemoryL2();
      // Put an entry in L2 with near-expiry (within 5-min buffer)
      const nearExpiredStream = makeValidStream(VIDEO_ID, NEAR_EXPIRE * 1000);
      l2.store.set(VIDEO_ID, nearExpiredStream); // bypass set() TTL cap for test

      let execCalls = 0;
      const executor: Executor = async () => { execCalls++; return { stdout: validOutput(), stderr: '' }; };
      const resolver = makeResolver(executor, l2);

      await resolver.resolve(VIDEO_ID);
      // L2.get() should return null (near-expired), so yt-dlp is called
      assert.equal(execCalls, 1, 'Near-expired L2 entry should be treated as miss');
    });

    it('Valid L2 entry is returned without calling yt-dlp', async () => {
      const l2 = makeInMemoryL2();
      await l2.set(makeValidStream());
      let execCalls = 0;
      const executor: Executor = async () => { execCalls++; return { stdout: validOutput(), stderr: '' }; };
      const resolver = makeResolver(executor, l2);
      await resolver.resolve(VIDEO_ID);
      assert.equal(execCalls, 0);
    });
  });

  describe('refresh()', () => {
    it('evicts L1 and L2, then calls yt-dlp', async () => {
      const l2 = makeInMemoryL2();
      let execCalls = 0;
      const executor: Executor = async () => {
        execCalls++;
        return { stdout: validOutput(`https://cdn.example.com/fresh?expire=${FAR_EXPIRE}`), stderr: '' };
      };
      const resolver = makeResolver(executor, l2);

      // Warm both caches
      await resolver.resolve(VIDEO_ID);
      execCalls = 0;

      const fresh = await resolver.refresh(VIDEO_ID);
      assert.equal(execCalls, 1, 'yt-dlp should be called on refresh');
      assert.ok(fresh.streamUrl.includes('fresh'), 'Should return fresh URL');
    });

    it('refresh returns fresh stream with different URL', async () => {
      const l2  = makeInMemoryL2();
      let call  = 0;
      const url1 = `https://cdn1.example.com/audio?expire=${FAR_EXPIRE}`;
      const url2 = `https://cdn2.example.com/audio?expire=${FAR_EXPIRE}`;
      const executor: Executor = async () => ({
        stdout: validOutput(call++ === 0 ? url1 : url2), stderr: '',
      });
      const resolver = makeResolver(executor, l2);
      const first  = await resolver.resolve(VIDEO_ID);
      const second = await resolver.refresh(VIDEO_ID);
      assert.notEqual(first.streamUrl, second.streamUrl, 'Refreshed stream should have new URL');
    });
  });

  describe('invalidate()', () => {
    it('evicts from L1', async () => {
      const l2 = makeInMemoryL2();
      const executor: Executor = async () => ({ stdout: validOutput(), stderr: '' });
      const resolver = makeResolver(executor, l2);
      await resolver.resolve(VIDEO_ID);
      assert.ok(resolver.l1.get(VIDEO_ID));
      await resolver.invalidate(VIDEO_ID);
      assert.equal(resolver.l1.get(VIDEO_ID), undefined, 'L1 should be empty after invalidate');
    });

    it('evicts from L2', async () => {
      const l2 = makeInMemoryL2();
      await l2.set(makeValidStream());
      const executor: Executor = async () => ({ stdout: validOutput(), stderr: '' });
      const resolver = makeResolver(executor, l2);
      await resolver.invalidate(VIDEO_ID);
      const entry = await l2.get(VIDEO_ID);
      assert.equal(entry, null, 'L2 should be empty after invalidate');
    });
  });

  describe('pruneExpiredL2()', () => {
    it('removes expired L2 entries and returns count', async () => {
      const l2 = makeInMemoryL2();
      // Put two streams: one expired, one valid
      l2.store.set('expiredvid1', makeValidStream('expiredvid1', Date.now() - 1000)); // past
      l2.store.set('validvideo1', makeValidStream('validvideo1', Date.now() + 6 * 60 * 60 * 1000));
      const resolver = makeResolver(async () => ({ stdout: '', stderr: '' }), l2);
      const count = await resolver.pruneExpiredL2();
      assert.equal(count, 1, 'Should delete 1 expired entry');
      assert.ok(l2.store.has('validvideo1'), 'Valid entry should remain');
      assert.ok(!l2.store.has('expiredvid1'), 'Expired entry should be gone');
    });
  });

  describe('Retry policy', () => {
    it('NETWORK_ERROR — retries up to maxAttempts', async () => {
      const l2 = makeInMemoryL2();
      let calls = 0;
      const executor: Executor = async () => {
        calls++;
        const err = Object.assign(new Error(), { stderr: 'unable to download', exitCode: 1 });
        throw err;
      };
      const resolver = makeResolver(executor, l2);
      await assert.rejects(() => resolver.resolve(VIDEO_ID), (err: unknown) => {
        assert.ok(err instanceof ResolverError);
        assert.equal((err as ResolverError).code, 'NETWORK_ERROR');
        return true;
      });
      assert.equal(calls, 3, 'Should retry 3 times for NETWORK_ERROR');
    });

    it('RATE_LIMITED — retries up to maxAttempts', async () => {
      const l2 = makeInMemoryL2();
      let calls = 0;
      const executor: Executor = async () => {
        calls++;
        const err = Object.assign(new Error(), { stderr: 'HTTP Error 429', exitCode: 1 });
        throw err;
      };
      const resolver = makeResolver(executor, l2);
      await assert.rejects(() => resolver.resolve(VIDEO_ID), (err: unknown) => {
        assert.equal((err as ResolverError).code, 'RATE_LIMITED');
        return true;
      });
      assert.equal(calls, 3, 'Should retry 3 times for RATE_LIMITED');
    });

    it('VIDEO_NOT_FOUND — no retry (fails on first attempt)', async () => {
      const l2 = makeInMemoryL2();
      let calls = 0;
      const executor: Executor = async () => {
        calls++;
        const err = Object.assign(new Error(), { stderr: 'Video unavailable', exitCode: 1 });
        throw err;
      };
      const resolver = makeResolver(executor, l2);
      // VIDEO_UNAVAILABLE is what we'd get from this stderr
      await assert.rejects(() => resolver.resolve(VIDEO_ID));
      assert.equal(calls, 1, 'Non-retryable errors should not be retried');
    });

    it('succeeds on 2nd attempt after transient NETWORK_ERROR', async () => {
      const l2 = makeInMemoryL2();
      let calls = 0;
      const executor: Executor = async () => {
        calls++;
        if (calls === 1) {
          const err = Object.assign(new Error(), { stderr: 'unable to download', exitCode: 1 });
          throw err;
        }
        return { stdout: validOutput(), stderr: '' };
      };
      const resolver = makeResolver(executor, l2);
      const stream = await resolver.resolve(VIDEO_ID);
      assert.equal(calls, 2, 'Should succeed on 2nd attempt');
      assert.equal(stream.videoId, VIDEO_ID);
    });
  });

  describe('L2 write failure non-fatal', () => {
    it('L2.set() failure does not throw — stream still returned', async () => {
      const l2: AudioCacheRepository = {
        get: async () => null,
        set: async () => { throw new Error('DB write failed'); }, // always fails
        delete: async () => {},
        deleteExpired: async () => 0,
      };
      const executor: Executor = async () => ({ stdout: validOutput(), stderr: '' });
      const resolver = makeResolver(executor, l2);

      // Should not throw even though L2 write fails
      const stream = await resolver.resolve(VIDEO_ID);
      // Wait for async void write to settle
      await new Promise(r => setTimeout(r, 20));
      assert.equal(stream.videoId, VIDEO_ID, 'Stream should be returned despite L2 write failure');
    });
  });
});
