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
};
