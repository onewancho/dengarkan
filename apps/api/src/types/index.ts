// ============================================
// DENGARKAN — Server-side Types
// ============================================

import type { FastifyRequest, FastifyReply } from 'fastify';

// Fastify augmentation — inject auth context into request
declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    username?: string;
  }
}

// Route handler signature shorthand
export type RouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<unknown>;
