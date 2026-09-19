// ============================================
// DENGARKAN — Auth Test Helpers
//
// Creates isolated Fastify apps for auth testing.
// No real database — service calls intercepted by in-memory mocks.
// ============================================

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { authRoutes } from '../modules/auth/routes.js';
import type { AuthServices } from '../modules/auth/routes.js';

// ── Mock types ────────────────────────────────────────────────────────────────

export interface MockUser {
  id: string;
  username: string;
  passwordHash: string; // Format: 'VALID:<correct_password>'
  createdAt?: Date;
  updatedAt?: Date;
}

// MockSession matches SessionRow from auth/routes.ts exactly
export interface MockSession {
  sessionId: string;
  userId: string;
  username: string;
  expiresAt: Date;
}

// ── Default mock services ─────────────────────────────────────────────────────

export function makeMockServices(
  users: MockUser[],
  sessions: Map<string, MockSession>,
  overrides?: Partial<AuthServices>
): AuthServices {
  return {
    findUserByUsername: async (username) => {
      const user = users.find((u) => u.username === username);
      if (!user) return null;
      return {
        ...user,
        createdAt: user.createdAt ?? new Date(),
        updatedAt: user.updatedAt ?? new Date(),
      };
    },

    verifyPassword: async (password, hash) => {
      // Fast mock — 'VALID:<expected_password>' encodes the correct password
      if (hash.startsWith('VALID:')) return password === hash.slice(6);
      return false;
    },

    createSession: async (userId) => {
      const user = users.find((u) => u.id === userId)!;
      const token = `tok-${userId}-${Date.now()}`;
      sessions.set(token, {
        sessionId: `sess-${Date.now()}`,
        userId,
        username: user.username,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
      return token;
    },

    deleteSession: async (token) => {
      sessions.delete(token);
    },

    validateSession: async (token) => {
      const s = sessions.get(token);
      if (!s) return null;
      if (s.expiresAt <= new Date()) {
        sessions.delete(token);
        return null;
      }
      // Cast to match the service return type (DB row shape)
      return s as typeof s;
    },

    ...overrides,
  };
}

// ── Standard test app (global rate limit: very high — tests run fast) ─────────

export function buildTestApp(
  users: MockUser[],
  sessions: Map<string, MockSession>,
  overrides?: Partial<AuthServices>
): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie, { secret: 'test-secret-32-chars-placeholder!!' });
  app.register(fastifyRateLimit, {
    global: true,
    max: 10000, // Very high — we don't test global limit here
    timeWindow: '1 minute',
  });

  const services = makeMockServices(users, sessions, overrides);
  app.register(authRoutes, { services });

  return app;
}

// ── Low-limit test app (for testing login rate limiting) ──────────────────────
//
// Uses a simple in-process counter instead of @fastify/rate-limit's store
// so that inject() tests reliably trigger 429 without real IP resolution.

export function buildTestAppWithLoginLimit(
  users: MockUser[],
  sessions: Map<string, MockSession>,
  loginMax: number = 3,
  overrides?: Partial<AuthServices>
): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyCookie, { secret: 'test-secret-32-chars-placeholder!!' });

  const services = makeMockServices(users, sessions, overrides);

  // Simple in-memory counter — keyed by x-forwarded-for or 'test-ip'
  const counter = new Map<string, number>();

  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'POST' || !request.url.includes('/api/auth/login')) return;
    const key =
      request.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ??
      request.ip ??
      'test-ip';
    const count = (counter.get(key) ?? 0) + 1;
    counter.set(key, count);
    if (count > loginMax) {
      await reply.status(429).send({
        error: 'Too Many Requests',
        message: `Too many login attempts. Try again later.`,
        statusCode: 429,
      });
    }
  });

  // Login endpoint
  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    if (!body?.username || !body?.password) {
      return reply.status(400).send({ error: 'Bad Request', statusCode: 400 });
    }
    const user = await services.findUserByUsername(body.username);
    if (!user) return reply.status(401).send({ statusCode: 401 });
    const valid = await services.verifyPassword(body.password, user.passwordHash);
    if (!valid) return reply.status(401).send({ statusCode: 401 });
    const token = await services.createSession(user.id);
    reply.setCookie('session_token', token, { httpOnly: true, path: '/' });
    return { user: { id: user.id, username: user.username } };
  });

  return app;
}

// ── Cookie parsing helpers ─────────────────────────────────────────────────────

export function parseCookies(
  header: string | string[] | undefined
): Record<string, string> {
  const raw = Array.isArray(header) ? header : header ? [header] : [];
  const result: Record<string, string> = {};
  for (const cookie of raw) {
    const [pair] = cookie.split(';');
    const [name, ...rest] = (pair ?? '').split('=');
    if (name) result[name.trim()] = rest.join('=').trim();
  }
  return result;
}

export function getCookieFlags(
  header: string | string[] | undefined
): string {
  const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
  return raw.toLowerCase();
}
