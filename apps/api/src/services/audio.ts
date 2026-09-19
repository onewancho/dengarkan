// ============================================
// DENGARKAN — Audio Resolver Service
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AudioResolver, AudioStream } from '@dengarkan/shared';

const execFileAsync = promisify(execFile);

// Cache buffer: consider stream expired 5 minutes before actual expiry
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const CACHE_MAX_SIZE = 500;
const YTDLP_TIMEOUT = parseInt(process.env.YTDLP_TIMEOUT || '30000', 10);

// yt-dlp format selector — Safari/iOS compatibility priority:
//   1. AAC in M4A container (native Safari)
//   2. AAC in any container
//   3. Any audio in MP4 container
//   4. Best available (may be Opus/WebM — fallback)
const FORMAT_SELECTOR =
  'bestaudio[ext=m4a]/bestaudio[acodec=aac]/bestaudio[ext=mp4]/bestaudio';

/**
 * LRU Cache with TTL for resolved audio streams.
 * Evicts least-recently-used entries when max size is reached.
 */
class LRUStreamCache {
  private cache = new Map<string, AudioStream>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(videoId: string): AudioStream | undefined {
    const entry = this.cache.get(videoId);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() >= entry.expiresAt - EXPIRY_BUFFER_MS) {
      this.cache.delete(videoId);
      return undefined;
    }

    // Move to end (most recently used) by re-inserting
    this.cache.delete(videoId);
    this.cache.set(videoId, entry);
    return entry;
  }

  set(videoId: string, stream: AudioStream): void {
    // Delete first to update insertion order
    this.cache.delete(videoId);

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    this.cache.set(videoId, stream);
  }

  delete(videoId: string): void {
    this.cache.delete(videoId);
  }

  get size(): number {
    return this.cache.size;
  }
}

class YouTubeAudioResolver implements AudioResolver {
  private cache = new LRUStreamCache(CACHE_MAX_SIZE);

  async resolve(videoId: string): Promise<AudioStream> {
    const cached = this.cache.get(videoId);
    if (cached) {
      return cached;
    }

    return this.fetchStream(videoId);
  }

  async refresh(videoId: string): Promise<AudioStream> {
    this.cache.delete(videoId);
    return this.fetchStream(videoId);
  }

  private async fetchStream(videoId: string): Promise<AudioStream> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const args = [
      '--dump-json',
      '--no-download',
      '--no-playlist',
      '--no-warnings',
      '-f',
      FORMAT_SELECTOR,
      '--', // G1 fix: flag terminator — prevents argument injection
      url,
    ];

    try {
      const ytdlpPath = process.env.YTDLP_PATH || 'yt-dlp';
      const { stdout } = await execFileAsync(ytdlpPath, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: YTDLP_TIMEOUT,
      });

      const data = JSON.parse(stdout);
      const streamUrl = data.url;
      if (!streamUrl) {
        throw new Error('No stream URL extracted from video');
      }

      // Parse expiration timestamp from Google Video URL param 'expire'
      let expiresAt = Date.now() + 6 * 60 * 60 * 1000; // default 6 hours
      try {
        const u = new URL(streamUrl);
        const expParam = u.searchParams.get('expire');
        if (expParam) {
          expiresAt = parseInt(expParam, 10) * 1000;
        }
      } catch {
        // Fallback to default
      }

      const stream: AudioStream = {
        videoId,
        streamUrl,
        mimeType: data.ext ? `audio/${data.ext}` : 'audio/mp4',
        codec: data.acodec || 'mp4a.40.2',
        bitrate: Math.round((data.abr || data.tbr || 128) * 1000),
        sampleRate: data.asr || 44100,
        durationSeconds: Math.round(data.duration || 0),
        expiresAt,
        title: data.title || data.fulltitle || 'Untitled Track',
        channelName: data.uploader || data.channel || 'Unknown Artist',
        thumbnailUrl:
          data.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };

      this.cache.set(videoId, stream);
      return stream;
    } catch (err: any) {
      throw new Error(
        `Failed to resolve audio stream for ${videoId}: ${err?.message || err}`
      );
    }
  }
}

export const audioResolver = new YouTubeAudioResolver();
