// ============================================
// DENGARKAN — Auth Middleware
//
// Validates session_token cookie and injects userId/username into request.
// Accepts an optional validateSession override for testability.
// ============================================

import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateSession as defaultValidateSession } from '../modules/auth/service.js';
import type { SessionRow } from '../modules/auth/routes.js';
import '../types/index.js';

export interface AuthMiddlewareOptions {
  validateSession?: (token: string) => Promise<SessionRow | null>;
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  _done?: unknown,
  options?: AuthMiddlewareOptions
): Promise<void> {
  const token =
    request.cookies?.session_token ||
    (request.query as Record<string, string> | undefined)?.token;

  if (!token) {
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Authentication required',
      statusCode: 401,
    });
    return;
  }

  const validate = options?.validateSession ?? defaultValidateSession;
  const session = await validate(token);

  if (!session) {
    reply.clearCookie('session_token', { path: '/' });
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or expired session',
      statusCode: 401,
    });
    return;
  }

  request.userId   = session.userId;
  request.username = session.username;
}
