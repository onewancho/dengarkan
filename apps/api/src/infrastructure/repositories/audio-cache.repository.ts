// ============================================
// DENGARKAN — Audio Cache Repository
//
// Persistent DB-backed cache for yt-dlp resolved stream URLs.
// Works alongside the in-memory LRU cache in resolver.ts:
//   L1 = in-memory LRU (fastest, process-scoped, lost on restart)
//   L2 = PostgreSQL audio_cache table (survives restarts, slower)
//
// TTL rules:
//   • A cached entry is valid if its expiresAt > now + EXPIRY_BUFFER_MS
//   • EXPIRY_BUFFER_MS (5 min) guards against CDN expiry race conditions
//   • On write: expiresAt = MIN(stream expiry, now + MAX_CACHE_MS)
//   • MAX_CACHE_MS = 5h (Google CDN URLs typically expire in 6h)
// ============================================

import { eq, lt } from 'drizzle-orm';
import { db, schema } from '../database/index.js';
import type { AudioStream } from '@dengarkan/shared';

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;   // 5 minutes
const MAX_CACHE_MS     = 5 * 60 * 60 * 1000; // 5 hours

// ── Repository Interface ──────────────────────────────────────────────────────
// Exported so tests can implement an in-memory version.

export interface AudioCacheRepository {
  get(videoId: string): Promise<AudioStream | null>;
  set(stream: AudioStream): Promise<void>;
  delete(videoId: string): Promise<void>;
  deleteExpired(): Promise<number>;
}

// ── In-Memory Fallback Store (for dev when DB is offline) ────────────────────
const memAudioCache = new Map<string, AudioStream>();

export const audioCacheRepository: AudioCacheRepository = {
  async get(videoId) {
    try {
      const [row] = await db
        .select()
        .from(schema.audioCache)
        .where(eq(schema.audioCache.videoId, videoId))
        .limit(1);

      if (row) {
        // Check TTL with buffer
        if (row.expiresAt <= Date.now() + EXPIRY_BUFFER_MS) {
          // Expired — delete asynchronously (don't block the caller)
          void db
            .delete(schema.audioCache)
            .where(eq(schema.audioCache.videoId, videoId))
            .catch(() => {});
          return null;
        }

        return dbRowToStream(row);
      }
    } catch {
      // In-memory fallback when DB is offline
    }

    const mem = memAudioCache.get(videoId);
    if (mem) {
      if (mem.expiresAt <= Date.now() + EXPIRY_BUFFER_MS) {
        memAudioCache.delete(videoId);
        return null;
      }
      return mem;
    }
    return null;
  },

  async set(stream) {
    // Cap expiry to MAX_CACHE_MS from now
    const expiresAt = Math.min(stream.expiresAt, Date.now() + MAX_CACHE_MS);
    memAudioCache.set(stream.videoId, { ...stream, expiresAt });

    try {
      await db
        .insert(schema.audioCache)
        .values({
          videoId:         stream.videoId,
          streamUrl:       stream.streamUrl,
          mimeType:        stream.mimeType,
          codec:           stream.codec,
          bitrate:         stream.bitrate,
          sampleRate:      stream.sampleRate,
          durationSeconds: stream.durationSeconds,
          title:           stream.title,
          channelName:     stream.channelName,
          thumbnailUrl:    stream.thumbnailUrl,
          expiresAt,
          updatedAt:       new Date(),
        })
        .onConflictDoUpdate({
          target: schema.audioCache.videoId,
          set: {
            streamUrl:       stream.streamUrl,
            mimeType:        stream.mimeType,
            codec:           stream.codec,
            bitrate:         stream.bitrate,
            sampleRate:      stream.sampleRate,
            durationSeconds: stream.durationSeconds,
            title:           stream.title,
            channelName:     stream.channelName,
            thumbnailUrl:    stream.thumbnailUrl,
            expiresAt,
            updatedAt:       new Date(),
          },
        });
    } catch {
      // DB offline — in-memory cache handled it
    }
  },

  async delete(videoId) {
    memAudioCache.delete(videoId);
    try {
      await db
        .delete(schema.audioCache)
        .where(eq(schema.audioCache.videoId, videoId));
    } catch {
      // Non-fatal
    }
  },

  async deleteExpired() {
    let count = 0;
    try {
      const result = await db
        .delete(schema.audioCache)
        .where(lt(schema.audioCache.expiresAt, Date.now()))
        .returning({ videoId: schema.audioCache.videoId });
      count = result.length;
    } catch {
      // In-memory fallback
    }

    const now = Date.now();
    for (const [id, s] of memAudioCache.entries()) {
      if (s.expiresAt <= now) {
        memAudioCache.delete(id);
        count++;
      }
    }
    return count;
  },
};

// ── Mapper ────────────────────────────────────────────────────────────────────

function dbRowToStream(row: {
  videoId: string;
  streamUrl: string;
  mimeType: string;
  codec: string;
  bitrate: number;
  sampleRate: number;
  durationSeconds: number;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  expiresAt: number;
}): AudioStream {
  return {
    videoId:         row.videoId,
    streamUrl:       row.streamUrl,
    mimeType:        row.mimeType,
    codec:           row.codec,
    bitrate:         row.bitrate,
    sampleRate:      row.sampleRate,
    durationSeconds: row.durationSeconds,
    title:           row.title,
    channelName:     row.channelName,
    thumbnailUrl:    row.thumbnailUrl,
    expiresAt:       row.expiresAt,
  };
}
