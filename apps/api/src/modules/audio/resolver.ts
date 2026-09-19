// ============================================
// DENGARKAN — Audio Module: Resolver
//
// Resolves YouTube video IDs to audio-only stream URLs via yt-dlp.
//
// Cache architecture (two-level):
//   L1: In-memory LRU (max 500, TTL-aware, process-scoped, ~0ms)
//   L2: PostgreSQL audio_cache (survives restarts, ~1-5ms)
//   yt-dlp: Invoked only on L1+L2 miss
//
// TTL strategy:
//   effectiveTTL = MIN(actualStreamExpiration, MAX_CACHE_MS)
//   Cache hit is valid only if expiresAt > now + EXPIRY_BUFFER_MS
//   EXPIRY_BUFFER_MS (5 min) = guard against CDN expiry race conditions
//   MAX_CACHE_MS (5.5h) = hard cap (Google CDN URLs typically expire in 6h)
//
// Cache flow:
//   resolve(videoId)
//     → L1 hit?  → return
//     → L2 hit?  → warm L1, return
//     → yt-dlp   → write L1 + L2, return
//
// Retry policy:
//   NETWORK_ERROR / RATE_LIMITED → exponential backoff, max 3 attempts
//   All other errors             → fail immediately
//
// Security:
//   • Video IDs validated against /^[A-Za-z0-9_-]{11}$/ before use.
//   • yt-dlp invoked via execFile (never shell), fixed args array.
//   • '--' flag terminator prevents argument injection.
//   • No arbitrary URLs are accepted.
//
// Format selection (priority):
//   1. bestaudio[ext=m4a]              — AAC/M4A, native Safari ✓
//   2. bestaudio[acodec=aac]           — AAC in any container ✓
//   3. bestaudio[ext=mp4]              — MP4 audio-only ✓
//   4. bestaudio[ext=webm][acodec=opus]— Opus/WebM, Chrome/Firefox ✓, Safari ✗
//   5. bestaudio                       — Last resort
//
// No video formats, no transcoding.
//
// Known limitations: see errors.ts
// ============================================

import { execFile } from 'node:child_process';
import { promisify }  from 'node:util';
import type { AudioResolver, AudioStream } from '@dengarkan/shared';
import { videoIdSchema } from '@dengarkan/shared';
import { ResolverError } from './errors.js';
import {
  type AudioCacheRepository,
  audioCacheRepository,
} from '../../infrastructure/repositories/audio-cache.repository.js';
import { withRetry } from '../../lib/retry.js';

const execFileAsync = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────────────────────

/** Treat stream as expired 5 min before actual CDN expiry (race-condition guard) */
const EXPIRY_BUFFER_MS  = 5    * 60 * 1000;
/** Hard cap: never cache a stream URL for more than 5.5h */
const MAX_CACHE_MS      = 5.5  * 60 * 60 * 1000;
const L1_CACHE_MAX_SIZE = 500;
const YTDLP_TIMEOUT_MS  = parseInt(process.env.YT_DLP_TIMEOUT || process.env.YTDLP_TIMEOUT || '30000', 10);

const FORMAT_SELECTOR =
  'bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio[ext=mp4]/bestaudio[ext=webm][acodec=opus]/bestaudio';

// ── yt-dlp stderr pattern matchers ───────────────────────────────────────────

const YTDLP_PATTERNS = {
  notFound:    /Video unavailable|This video is not available|This video has been removed|No video formats found|No such file or directory/i,
  unavailable: /Sign in to confirm|age.?restricted|members.?only|private video|This video is private|video is unavailable/i,
  rateLimit:   /HTTP Error 429|Too Many Requests|rate.?limit/i,
  network:     /unable to download|network/i,
  liveStream:  /is a live stream|live stream/i,
} as const;

function classifyYtdlpError(stderr: string, exitCode: number | null): ResolverError {
  const text = stderr.toLowerCase();
  if (YTDLP_PATTERNS.rateLimit.test(stderr))    return new ResolverError('RATE_LIMITED',      'YouTube rate limited the request');
  if (YTDLP_PATTERNS.unavailable.test(stderr))  return new ResolverError('VIDEO_UNAVAILABLE', 'Video requires sign-in or is restricted');
  if (YTDLP_PATTERNS.notFound.test(stderr))     return new ResolverError('VIDEO_NOT_FOUND',   'Video not found or removed');
  if (YTDLP_PATTERNS.liveStream.test(stderr))   return new ResolverError('NO_AUDIO_STREAM',   'Live streams are not supported');
  if (YTDLP_PATTERNS.network.test(stderr))      return new ResolverError('NETWORK_ERROR',     'Network error during resolution');
  if (exitCode === 1 && text.includes('error')) return new ResolverError('VIDEO_UNAVAILABLE', `Video unavailable: ${stderr.slice(0, 150)}`);
  return new ResolverError('RESOLVER_FAILED', `yt-dlp failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
}

// ── In-process L1 LRU Cache ───────────────────────────────────────────────────

class LRUStreamCache {
  private readonly cache = new Map<string, AudioStream>();

  constructor(private readonly maxSize: number) {}

  get(videoId: string): AudioStream | undefined {
    const entry = this.cache.get(videoId);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt - EXPIRY_BUFFER_MS) {
      this.cache.delete(videoId);
      return undefined;
    }
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
  get size(): number { return this.cache.size; }
}

// ── yt-dlp JSON output shape ──────────────────────────────────────────────────

interface YtdlpOutput {
  url?:        string;
  ext?:        string;
  acodec?:     string;
  vcodec?:     string;
  abr?:        number;
  tbr?:        number;
  asr?:        number;
  duration?:   number;
  title?:      string;
  fulltitle?:  string;
  uploader?:   string;
  channel?:    string;
  thumbnail?:  string;
  is_live?:    boolean;
  live_status?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseExpiry(streamUrl: string): number {
  try {
    const expParam = new URL(streamUrl).searchParams.get('expire');
    if (expParam) {
      const epoch = parseInt(expParam, 10) * 1000;
      if (isFinite(epoch) && epoch > Date.now()) return epoch;
    }
  } catch { /* ignore */ }
  return Date.now() + 6 * 60 * 60 * 1000; // default 6h
}

function parseMimeType(ext: string | undefined): string {
  switch (ext) {
    case 'm4a':  return 'audio/mp4';
    case 'aac':  return 'audio/aac';
    case 'mp3':  return 'audio/mpeg';
    case 'ogg':  return 'audio/ogg';
    case 'webm': return 'audio/webm';
    case 'flac': return 'audio/flac';
    case 'wav':  return 'audio/wav';
    default:     return 'audio/mp4';
  }
}

function buildStream(videoId: string, data: YtdlpOutput): AudioStream {
  if (!data.url) throw new ResolverError('NO_AUDIO_STREAM', 'yt-dlp returned no stream URL');
  if (data.is_live || data.live_status === 'is_live') {
    throw new ResolverError('NO_AUDIO_STREAM', 'Live streams are not supported');
  }
  if (data.vcodec && data.vcodec !== 'none' && data.vcodec !== 'null') {
    throw new ResolverError('NO_AUDIO_STREAM', `yt-dlp selected a video+audio format (vcodec=${data.vcodec})`);
  }

  const expiresAt = Math.min(parseExpiry(data.url), Date.now() + MAX_CACHE_MS);

  return {
    videoId,
    streamUrl:       data.url,
    mimeType:        parseMimeType(data.ext),
    codec:           data.acodec ?? 'mp4a.40.2',
    bitrate:         Math.round((data.abr ?? data.tbr ?? 128) * 1000),
    sampleRate:      data.asr ?? 44100,
    durationSeconds: Math.round(data.duration ?? 0),
    expiresAt,
    title:           data.title ?? data.fulltitle ?? 'Untitled Track',
    channelName:     data.uploader ?? data.channel ?? 'Unknown Artist',
    thumbnailUrl:    data.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

// ── Resolver ──────────────────────────────────────────────────────────────────

class YouTubeAudioResolver implements AudioResolver {
  private readonly l1 = new LRUStreamCache(L1_CACHE_MAX_SIZE);

  constructor(private readonly l2: AudioCacheRepository) {}

  // ── resolve: L1 → L2 → yt-dlp ───────────────────────────────────────────

  async resolve(videoId: string): Promise<AudioStream> {
    const parsed = videoIdSchema.safeParse(videoId);
    if (!parsed.success) {
      throw new ResolverError('VIDEO_NOT_FOUND', `Invalid YouTube video ID: "${videoId}"`);
    }
    const id = parsed.data;

    // L1 hit
    const l1Hit = this.l1.get(id);
    if (l1Hit) return l1Hit;

    // L2 hit — warm L1 and return
    try {
      const l2Hit = await this.l2.get(id);
      if (l2Hit) {
        this.l1.set(id, l2Hit);
        return l2Hit;
      }
    } catch {
      // Non-fatal if L2 is offline
    }

    // Cache miss — call yt-dlp (with retry on transient errors)
    return withRetry(() => this.fetchAndCache(id));
  }

  // ── refresh: evict L1+L2, re-fetch ──────────────────────────────────────

  async refresh(videoId: string): Promise<AudioStream> {
    const parsed = videoIdSchema.safeParse(videoId);
    if (!parsed.success) {
      throw new ResolverError('VIDEO_NOT_FOUND', `Invalid YouTube video ID: "${videoId}"`);
    }
    const id = parsed.data;

    // Evict both cache layers
    this.l1.delete(id);
    try {
      await this.l2.delete(id);
    } catch {
      // Non-fatal
    }

    // Re-fetch with retry
    return withRetry(() => this.fetchAndCache(id));
  }

  // ── yt-dlp execution ─────────────────────────────────────────────────────

  private async fetchAndCache(videoId: string): Promise<AudioStream> {
    const ytdlpPath = process.env.YT_DLP_PATH || process.env.YTDLP_PATH || 'yt-dlp';
    const url       = `https://www.youtube.com/watch?v=${videoId}`;

    const args = [
      '--dump-json',
      '--no-download',
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout', '20',
      '-f', FORMAT_SELECTOR,
      '--',
      url,
    ];

    let stdout: string;
    let stderr: string;

    try {
      const result = await execFileAsync(ytdlpPath, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout:   YTDLP_TIMEOUT_MS,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err: unknown) {
      const e = err as {
        stderr?: string;
        exitCode?: number;
        killed?: boolean;
        signal?: string;
        code?: string;
        message?: string;
      };
      if (e.code === 'ENOENT') {
        throw new ResolverError(
          'RESOLVER_FAILED',
          `yt-dlp executable not found at "${ytdlpPath}". Please ensure yt-dlp is installed and available in PATH on the server.`,
          err,
        );
      }
      if (e.killed || e.signal === 'SIGTERM') {
        throw new ResolverError('RESOLVER_FAILED', `yt-dlp timed out after ${YTDLP_TIMEOUT_MS}ms`);
      }
      throw classifyYtdlpError(e.stderr || e.message || '', typeof e.exitCode === 'number' ? e.exitCode : null);
    }

    let data: YtdlpOutput;
    try {
      data = JSON.parse(stdout) as YtdlpOutput;
    } catch {
      throw new ResolverError('RESOLVER_FAILED', 'yt-dlp returned invalid JSON');
    }

    const stream = buildStream(videoId, data);

    // Write to both caches (L2 write is async — don't block the response)
    this.l1.set(videoId, stream);
    void this.l2.set(stream).catch(() => { /* L2 write failures are non-fatal */ });

    return stream;
  }

  /** Evict a specific video from both caches (e.g. after a 403) */
  async invalidate(videoId: string): Promise<void> {
    this.l1.delete(videoId);
    await this.l2.delete(videoId);
  }

  /** Remove all expired entries from L2 DB cache. Call from a cron/cleanup job. */
  async pruneExpiredL2(): Promise<number> {
    return this.l2.deleteExpired();
  }

  get l1Size(): number { return this.l1.size; }
}

export const audioResolver = new YouTubeAudioResolver(audioCacheRepository);
