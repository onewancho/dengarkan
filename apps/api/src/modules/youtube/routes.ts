// ============================================
// DENGARKAN — YouTube Module: Routes
// ============================================

import type { FastifyPluginAsync } from 'fastify';
import { searchQuerySchema } from '@dengarkan/shared';
import { authMiddleware } from '../../middleware/auth.js';
import { searchTracks } from './service.js';

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
};
