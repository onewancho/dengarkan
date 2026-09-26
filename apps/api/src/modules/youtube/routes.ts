// ============================================
// DENGARKAN — YouTube Module: Routes
// ============================================

import type { FastifyPluginAsync } from 'fastify';
import { searchQuerySchema } from '@dengarkan/shared';
import { authMiddleware } from '../../middleware/auth.js';
import { searchTracks, relatedTracks, TRENDING_INTERESTS } from './service.js';

export const youtubeRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/youtube/search?q=query
  app.get(
    '/api/youtube/search',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const parsed = searchQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message || 'Invalid search query',
          statusCode: 400,
        });
      }

      try {
        const response = await searchTracks(parsed.data.q);
        return response;
      } catch (err: any) {
        request.log.error('Search failed: %s', err?.message || err);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to search YouTube',
          statusCode: 500,
        });
      }
    }
  );

  // GET /api/youtube/related?videoId=xxx&hint=artist+title
  app.get(
    '/api/youtube/related',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const { videoId, hint } = (request.query ?? {}) as { videoId?: string; hint?: string };
      if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid videoId',
          statusCode: 400,
        });
      }
      try {
        return await relatedTracks(videoId, typeof hint === 'string' ? hint : undefined);
      } catch (err: any) {
        request.log.error('Related failed: %s', err?.message || err);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to fetch related tracks',
          statusCode: 500,
        });
      }
    }
  );

  // GET /api/youtube/trending
  app.get('/api/youtube/trending', { preHandler: [authMiddleware] }, async () => TRENDING_INTERESTS);
};
