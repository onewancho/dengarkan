// ============================================
// DENGARKAN — Auth Module: Routes
//
// Security hardening:
// • Per-IP rate limit (10 / 15 min) on /api/auth/login
// • Constant-time dummy hash for unknown users (timing-attack safe)
// • HttpOnly / SameSite / Secure session cookie
// • Vague error messages — no user-existence leakage
// • Injectable services for testability (no real DB needed in tests)
// ============================================

import type { FastifyPluginAsync } from 'fastify';
import { loginSchema } from '@dengarkan/shared';
import * as defaultServices from './service.js';
import { authMiddleware } from '../../middleware/auth.js';

// ── User / Session shapes ─────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRow {
  sessionId: string;
  userId: string;
  username: string;
  expiresAt: Date;
}

// ── Service interface — allows tests to inject mocks ─────────────────────────

export interface AuthServices {
  findUserByUsername: (username: string) => Promise<UserRow | null>;
  verifyPassword:     (password: string, hash: string) => Promise<boolean>;
  createSession:      (userId: string) => Promise<string>;
  deleteSession:      (token: string) => Promise<void>;
  validateSession:    (token: string) => Promise<SessionRow | null>;
}

export interface AuthRouteOptions {
  services?: Partial<AuthServices>;
}

// ── Cookie helper ─────────────────────────────────────────────────────────────

const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days (seconds)

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE,
  };
}

// ── Constant-time dummy hash (prevents user-enumeration via timing) ───────────
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJuXzBWEHqVzZ7a3bJe3w';

// ── Generic 401 body (safe: reveals nothing about user existence) ─────────────
const AUTH_ERROR = {
  error: 'Unauthorized',
  message: 'Invalid username or password',
  statusCode: 401,
} as const;

// ── Plugin ────────────────────────────────────────────────────────────────────

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (
  app,
  options
) => {
  const svc: AuthServices = {
    findUserByUsername: options.services?.findUserByUsername ?? defaultServices.findUserByUsername,
    verifyPassword:     options.services?.verifyPassword     ?? defaultServices.verifyPassword,
    createSession:      options.services?.createSession      ?? defaultServices.createSession,
    deleteSession:      options.services?.deleteSession      ?? defaultServices.deleteSession,
    validateSession:    options.services?.validateSession    ?? defaultServices.validateSession,
  };

  // ── Login — wrapped in its own scope so the rate limit applies only here ────
  await app.register(async (loginScope) => {
    // Per-IP brute-force protection: 10 attempts per 15 minutes
    loginScope.register(
      (await import('@fastify/rate-limit')).default,
      {
        global: false,
        max: 10,
        timeWindow: '15 minutes',
        keyGenerator: (req) =>
          req.ip ??
          req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ??
          'unknown',
        skipOnError: false,
        errorResponseBuilder: (_req, context) => ({
          error: 'Too Many Requests',
          message: `Too many login attempts. Try again in ${context.after}.`,
          statusCode: 429,
        }),
      }
    );

    // POST /api/auth/login
    loginScope.post('/api/auth/login', async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Invalid request body',
          statusCode: 400,
        });
      }

      const { username, password } = parsed.data;
      const user = await svc.findUserByUsername(username);

      if (!user) {
        // Always run argon2 — constant-time regardless of user existence
        await svc.verifyPassword(password, DUMMY_HASH);
        return reply.status(401).send(AUTH_ERROR);
      }

      const valid = await svc.verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send(AUTH_ERROR);
      }

      const token = await svc.createSession(user.id);
      reply.setCookie('session_token', token, cookieOptions());

      // Never expose the password hash or internal session token in the body
      return reply.status(200).send({
        user: { id: user.id, username: user.username },
      });
    });
  });

  // ── POST /api/auth/logout ─────────────────────────────────────────────────

  app.post(
    '/api/auth/logout',
    {
      preHandler: (req, rep, done) =>
        authMiddleware(req, rep, done, { validateSession: svc.validateSession }),
    },
    async (request, reply) => {
      const token = request.cookies?.session_token;
      if (token) await svc.deleteSession(token);
      reply.clearCookie('session_token', {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
      });
      return reply.status(200).send({ message: 'Logged out successfully' });
    }
  );

  // ── GET /api/auth/session ─────────────────────────────────────────────────

  app.get(
    '/api/auth/session',
    {
      preHandler: (req, rep, done) =>
        authMiddleware(req, rep, done, { validateSession: svc.validateSession }),
    },
    async (request, reply) => {
      return reply.status(200).send({
        user: { id: request.userId, username: request.username },
      });
    }
  );
};
