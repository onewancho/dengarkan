// ============================================
// DENGARKAN — Auth Routes
// ============================================

import type { FastifyInstance } from 'fastify';
import { loginSchema } from '@dengarkan/shared';
import {
  findUserByUsername,
  verifyPassword,
  createSession,
  deleteSession,
} from '../services/auth.js';
import { authMiddleware } from '../middleware/auth.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
};

export async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/login
  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid username or password format',
        statusCode: 400,
      });
    }

    const { username, password } = parsed.data;

    const user = await findUserByUsername(username);

    if (!user) {
      // Constant-time: still do a hash comparison to prevent timing attacks
      await verifyPassword(password, '$argon2id$v=19$m=65536,t=3,p=4$dummysalt$dummyhash');
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid username or password',
        statusCode: 401,
      });
    }

    const valid = await verifyPassword(password, user.passwordHash);

    if (!valid) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid username or password',
        statusCode: 401,
      });
    }

    const token = await createSession(user.id);

    reply.setCookie('session_token', token, COOKIE_OPTIONS);

    return reply.send({
      user: {
        id: user.id,
        username: user.username,
      },
    });
  });

  // POST /api/auth/logout
  app.post(
    '/api/auth/logout',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const token = request.cookies?.session_token;
      if (token) {
        await deleteSession(token);
      }
      reply.clearCookie('session_token', { path: '/' });
      return reply.send({ message: 'Logged out' });
    }
  );

  // GET /api/auth/session
  app.get(
    '/api/auth/session',
    { preHandler: authMiddleware },
    async (request, reply) => {
      return reply.send({
        user: {
          id: request.userId,
          username: request.username,
        },
      });
    }
  );
}
