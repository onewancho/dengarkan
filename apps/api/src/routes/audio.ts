// ============================================
// DENGARKAN — Audio Resolver Routes
// ============================================

import type { FastifyPluginAsync } from 'fastify';
import { videoIdSchema } from '@dengarkan/shared';
import { authMiddleware } from '../middleware/auth.js';
import { audioResolver } from '../services/audio.js';

const resolveBodySchema = {
  type: 'object' as const,
  properties: {
    videoId: { type: 'string' as const },
  },
  required: ['videoId'] as const,
};

export const audioRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/audio/resolve
  app.post<{ Body: { videoId: string } }>(
    '/api/audio/resolve',
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      const body = request.body as { videoId?: string };
      const parsed = videoIdSchema.safeParse(body?.videoId);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message || 'Invalid video ID',
          statusCode: 400,
        });
      }

      try {
        const stream = await audioResolver.resolve(parsed.data);
        return stream;
      } catch (err: any) {
        request.log.error(
          'Audio stream resolution failed: %s',
          err?.message || err
        );
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to resolve audio stream URL',
          statusCode: 500,
        });
      }
    }
  );

  // POST /api/audio/refresh
  app.post<{ Body: { videoId: string } }>(
    '/api/audio/refresh',
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      const body = request.body as { videoId?: string };
      const parsed = videoIdSchema.safeParse(body?.videoId);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message || 'Invalid video ID',
          statusCode: 400,
        });
      }

      try {
        const stream = await audioResolver.refresh(parsed.data);
        return stream;
      } catch (err: any) {
        request.log.error(
          'Audio stream refresh failed: %s',
          err?.message || err
        );
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Failed to refresh audio stream URL',
          statusCode: 500,
        });
      }
    }
  );
};
