// ============================================
// DENGARKAN — Audio Module: Routes
//
// POST /api/audio/resolve  — resolve videoId → AudioStream (L1→L2→yt-dlp)
// POST /api/audio/refresh  — force-refresh cached stream (evict L1+L2, re-fetch)
// POST /api/audio/invalidate — evict a specific video from all caches
// POST /api/audio/cleanup    — delete expired entries from L2 DB cache
//
// Error handling maps ResolverError codes to structured HTTP responses.
// ============================================

import type { FastifyPluginAsync } from 'fastify';
import { videoIdSchema } from '@dengarkan/shared';
import { authMiddleware } from '../../middleware/auth.js';
import { audioResolver } from './resolver.js';
import { generateHlsPlaylist, streamHlsSegment, type HlsTrack } from './hls.service.js';
import {
  streamContinuousQueue,
  parseContinuousTracks,
  skipContinuousSession,
  updateContinuousSessionQueue,
  setContinuousSessionRepeat,
} from './continuous-stream.service.js';
import {
  ResolverError,
  resolverErrorStatus,
  resolverErrorMessage,
} from './errors.js';

// ── Error handler helper ──────────────────────────────────────────────────────

function sendResolverError(
  err: unknown,
  reply: { status: (n: number) => { send: (b: object) => unknown } },
  log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void },
) {
  if (err instanceof ResolverError) {
    const status  = resolverErrorStatus[err.code];
    const message = resolverErrorMessage[err.code];
    if (status >= 500) log.error('Resolver [%s]: %s', err.code, err.message);
    else               log.warn('Resolver [%s]: %s', err.code, err.message);
    return reply.status(status).send({
      error: err.code,
      message,
      details: err.message,
      statusCode: status,
    });
  }
  const msg = err instanceof Error ? err.message : 'Unknown error';
  log.error('Resolver unexpected: %s', msg);
  return reply.status(500).send({
    error: 'RESOLVER_FAILED',
    message: 'Failed to resolve audio stream',
    details: msg,
    statusCode: 500,
  });
}

export const audioRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/audio/resolve ────────────────────────────────────────────────

  app.post(
    '/api/audio/resolve',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const body = request.body as { videoId?: unknown };
      const parsed = videoIdSchema.safeParse(body?.videoId);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request', message: 'Invalid YouTube video ID', statusCode: 400,
        });
      }
      try {
        return await audioResolver.resolve(parsed.data);
      } catch (err) {
        return sendResolverError(err, reply, request.log);
      }
    }
  );

  // ── GET /api/audio/stream/:videoId ────────────────────────────────────────
  // Server-side proxy for CDN audio stream.
  // YouTube CDN URLs are IP-bound to the server — clients on other IPs (LAN,
  // mobile devices) get 403 if they try to access the CDN URL directly.
  // This endpoint resolves the stream, then proxies the CDN response through
  // the server so any authenticated client can play audio without IP issues.
  // Supports Range requests for seeking.

  app.get(
    '/api/audio/stream/:videoId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const params = request.params as { videoId?: string };
      const parsed = videoIdSchema.safeParse(params.videoId);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request', message: 'Invalid YouTube video ID', statusCode: 400,
        });
      }

      let stream;
      try {
        stream = await audioResolver.resolve(parsed.data);
      } catch (err) {
        return sendResolverError(err, reply, request.log);
      }

      const rangeHeader = request.headers['range'];
      const fetchHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.youtube.com/',
      };
      if (rangeHeader) fetchHeaders['Range'] = rangeHeader;

      let cdnRes: Response;
      try {
        cdnRes = await fetch(stream.streamUrl, { headers: fetchHeaders });
      } catch (err) {
        request.log.error({ err }, 'Failed to fetch CDN stream');
        return reply.status(502).send({
          error: 'STREAM_PROXY_ERROR',
          message: 'Failed to fetch audio from CDN',
          statusCode: 502,
        });
      }

      if (!cdnRes.ok && cdnRes.status !== 206) {
        // CDN URL expired — evict cache and tell client to retry
        void audioResolver.invalidate(parsed.data);
        return reply.status(503).send({
          error: 'STREAM_EXPIRED',
          message: 'Audio stream expired, please retry',
          statusCode: 503,
        });
      }

      reply.status(cdnRes.status);
      reply.header('Content-Type', cdnRes.headers.get('Content-Type') || stream.mimeType);
      reply.header('Cache-Control', 'no-cache');
      reply.header('Access-Control-Allow-Origin', '*');
      const contentLength = cdnRes.headers.get('Content-Length');
      if (contentLength) reply.header('Content-Length', contentLength);
      const contentRange = cdnRes.headers.get('Content-Range');
      if (contentRange) reply.header('Content-Range', contentRange);
      reply.header('Accept-Ranges', 'bytes');

      if (!cdnRes.body) {
        return reply.send(Buffer.alloc(0));
      }

      // Stream body chunks directly to client
      const reader = cdnRes.body.getReader();
      const rawReply = reply.raw;
      reply.hijack();
      rawReply.writeHead(cdnRes.status, {
        'Content-Type': cdnRes.headers.get('Content-Type') || stream.mimeType,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        ...(contentLength ? { 'Content-Length': contentLength } : {}),
        ...(contentRange ? { 'Content-Range': contentRange } : {}),
      });

      request.raw.on('close', () => reader.cancel().catch(() => {}));
      request.raw.on('aborted', () => reader.cancel().catch(() => {}));

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || rawReply.destroyed || rawReply.writableEnded) break;
          rawReply.write(value);
        }
      } catch {
        // client disconnected
      } finally {
        reader.cancel().catch(() => {});
        if (!rawReply.destroyed && !rawReply.writableEnded) rawReply.end();
      }
    }
  );

  // ── POST /api/audio/refresh ────────────────────────────────────────────────
  // Force-refresh: evicts both caches and calls yt-dlp fresh.
  // Frontend calls this when it receives an HTTP 403 on the stream URL.

  app.post(
    '/api/audio/refresh',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const body = request.body as { videoId?: unknown };
      const parsed = videoIdSchema.safeParse(body?.videoId);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request', message: 'Invalid YouTube video ID', statusCode: 400,
        });
      }
      try {
        return await audioResolver.refresh(parsed.data);
      } catch (err) {
        return sendResolverError(err, reply, request.log);
      }
    }
  );

  // ── POST /api/audio/invalidate ─────────────────────────────────────────────
  // Evict a video from L1+L2 without fetching a replacement.
  // Useful when the client detects a 403 but doesn't need to play immediately.

  app.post(
    '/api/audio/invalidate',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const body = request.body as { videoId?: unknown };
      const parsed = videoIdSchema.safeParse(body?.videoId);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request', message: 'Invalid YouTube video ID', statusCode: 400,
        });
      }
      await audioResolver.invalidate(parsed.data);
      return reply.status(200).send({ ok: true });
    }
  );

  // ── POST /api/audio/cleanup ────────────────────────────────────────────────
  // Delete expired entries from the L2 DB cache.
  // Can be called from a cron job or admin endpoint.

  app.post(
    '/api/audio/cleanup',
    { preHandler: [authMiddleware] },
    async (_request, reply) => {
      const deleted = await audioResolver.pruneExpiredL2();
      return reply.status(200).send({ deleted });
    }
  );

  // ── GET /api/audio/hls/playlist.m3u8 ───────────────────────────────────────
  // Dynamic HLS playlist for continuous queue/playlist playback on iOS Safari.
  // Resolves WebKit background suspension (Bug 173332) by letting AVPlayer
  // manage track transitions natively in iOS mediaserverd.

  app.get(
    '/api/audio/hls/playlist.m3u8',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const query = request.query as {
        tracks?: string;
        start?: string;
        token?: string;
      };

      const tracksParam = query.tracks || '';
      let tracks: HlsTrack[] = [];

      if (tracksParam.startsWith('[') || tracksParam.startsWith('{')) {
        try {
          const parsed = JSON.parse(tracksParam);
          tracks = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          // ignore parse error, fallback below
        }
      }

      if (tracks.length === 0 && tracksParam) {
        // format: "videoId:duration:title:artist,videoId:duration..."
        const items = tracksParam.split(',');
        for (const item of items) {
          const parts = item.split(':');
          const videoId = parts[0]?.trim();
          if (videoId && videoIdSchema.safeParse(videoId).success) {
            const durationSeconds = parseFloat(parts[1] || '180') || 180;
            const title = parts[2] ? decodeURIComponent(parts[2]) : undefined;
            const artist = parts[3] ? decodeURIComponent(parts[3]) : undefined;
            tracks.push({ videoId, durationSeconds, title, artist });
          }
        }
      }

      const startIndex = parseInt(query.start || '0', 10) || 0;
      const token = request.cookies?.session_token || query.token;
      const manifest = generateHlsPlaylist(tracks, startIndex, token);

      reply.header('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.send(manifest);
    }
  );

  // ── GET /api/audio/hls/segment/:videoId.aac ────────────────────────────────
  // Streams a bit-for-bit ADTS AAC audio segment using ffmpeg-static (-c:a copy).

  app.get(
    '/api/audio/hls/segment/:videoId.aac',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const params = request.params as { videoId?: string };
      const parsed = videoIdSchema.safeParse(params.videoId);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid YouTube video ID',
          statusCode: 400,
        });
      }

      const query = request.query as { title?: string; artist?: string };
      return streamHlsSegment(
        parsed.data,
        { title: query.title, artist: query.artist },
        request,
        reply
      );
    }
  );

  // ── GET /api/audio/continuous ──────────────────────────────────────────────
  // Continuous audio stream for mobile Safari & Chrome on locked screen.
  // Streams the entire queue through a single chunked HTTP response without changing audio.src.

  app.get(
    '/api/audio/continuous',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const query = request.query as {
        tracks?: string;
        start?: string;
        sessionId?: string;
        seek?: string;
        repeat?: 'none' | 'one' | 'all';
      };

      const tracks = parseContinuousTracks(query.tracks);
      const startIndex = parseInt(query.start || '0', 10) || 0;
      const initialSeek = query.seek ? parseFloat(query.seek) : undefined;

      await streamContinuousQueue(tracks, startIndex, request, reply, query.sessionId, initialSeek, query.repeat);
    }
  );

  // ── POST /api/audio/continuous/skip ────────────────────────────────────────
  // Skips the current track in the active continuous stream without breaking the HTTP connection.

  app.post(
    '/api/audio/continuous/skip',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const body = (request.body as { sessionId?: string; nextIndex?: number } | undefined) ?? {};
      if (!body.sessionId) {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'sessionId is required',
          statusCode: 400,
        });
      }

      const skipped = skipContinuousSession(body.sessionId, body.nextIndex);
      return reply.send({ success: skipped });
    }
  );

  // ── POST /api/audio/continuous/queue ───────────────────────────────────────
  // Dynamically updates the tracks of an ongoing continuous streaming session.

  app.post(
    '/api/audio/continuous/queue',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const body = (request.body as { sessionId?: string; tracks?: unknown } | undefined) ?? {};
      if (!body.sessionId) {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'sessionId is required',
          statusCode: 400,
        });
      }

      const tracks = Array.isArray(body.tracks)
        ? (body.tracks as any[])
        : parseContinuousTracks(typeof body.tracks === 'string' ? body.tracks : undefined);

      const updated = updateContinuousSessionQueue(body.sessionId, tracks);
      return reply.send({ success: updated });
    }
  );

  // ── POST /api/audio/continuous/repeat ──────────────────────────────────────
  // Dynamically updates repeatMode of an ongoing continuous streaming session.

  app.post(
    '/api/audio/continuous/repeat',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const body = (request.body as { sessionId?: string; repeatMode?: 'none' | 'one' | 'all' } | undefined) ?? {};
      if (!body.sessionId) {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'sessionId is required',
          statusCode: 400,
        });
      }

      const updated = setContinuousSessionRepeat(body.sessionId, body.repeatMode || 'none');
      return reply.send({ success: updated });
    }
  );
};
