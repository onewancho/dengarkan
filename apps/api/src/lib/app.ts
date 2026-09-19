// ============================================
// DENGARKAN — Server Factory
//
// Separated from server.ts entry point so tests
// can create an isolated app instance without
// starting a real TCP listener.
// ============================================

import '../types/index.js';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';

import { authRoutes }     from '../modules/auth/routes.js';
import { youtubeRoutes }  from '../modules/youtube/routes.js';
import { audioRoutes }    from '../modules/audio/routes.js';
import { playlistRoutes } from '../modules/playlists/routes.js';

export interface AppOptions {
  /** Disable logger for tests */
  silent?: boolean;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const isDev = process.env.NODE_ENV !== 'production';

  const app = Fastify({
    logger: options.silent
      ? false
      : {
          level: isDev ? 'info' : 'warn',
          transport: isDev
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
        },
    // Trust proxy headers (needed when behind Nginx / Cloudflare)
    trustProxy: !isDev,
  });

  // ── Security Headers (fastify-helmet) ──────────────────────────────────────
  await app.register(fastifyHelmet, {
    // Content-Security-Policy
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'"],
        styleSrc:       ["'self'", "'unsafe-inline'"], // Tailwind inlines styles
        imgSrc:         ["'self'", 'data:', 'https://i.ytimg.com'],
        mediaSrc:       ["'self'", 'https://*.googlevideo.com', 'blob:'],
        connectSrc:     ["'self'"],
        fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
        objectSrc:      ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: isDev ? null : [],
      },
    },
    // HSTS: 1 year, include subdomains, preload (production only)
    hsts: isDev
      ? false
      : { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    // Prevent MIME sniffing
    noSniff: true,
    // Block iframing
    frameguard: { action: 'deny' },
    // Referrer policy
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Permissions policy
    permittedCrossDomainPolicies: false,
    // Hide X-Powered-By
    hidePoweredBy: true,
  });

  // ── CORS ───────────────────────────────────────────────────────────────────
  await app.register(fastifyCors, {
    origin: isDev
      ? (origin, cb) => {
          if (!origin) {
            cb(null, true);
            return;
          }
          const isAllowed = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(
            origin
          );
          cb(null, isAllowed);
        }
      : ['https://dengarkan.my.id'],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Cookie'],
    exposedHeaders: ['Set-Cookie'],
  });

  // ── Signed Cookies ─────────────────────────────────────────────────────────
  const sessionSecret = process.env.SESSION_SECRET;
  if (!isDev && (!sessionSecret || sessionSecret.length < 32)) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }
  await app.register(fastifyCookie, {
    secret: sessionSecret || 'dev-secret-change-me-in-production-placeholder',
    parseOptions: {},
  });

  // ── Global Rate Limit (baseline — login has its own stricter limit) ────────
  await app.register(fastifyRateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    // Key by real IP (works behind trusted proxy)
    keyGenerator: (request) =>
      request.ip ?? request.headers['x-forwarded-for']?.toString() ?? 'unknown',
    errorResponseBuilder: (_req, context) => ({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Retry in ${context.after}.`,
      statusCode: 429,
    }),
  });

  // ── Resilient JSON Content-Type Parser (tolerates empty bodies) ─────────────
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      if (!body || body.trim() === '') {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  // ── Routes ─────────────────────────────────────────────────────────────────
  await app.register(authRoutes);
  await app.register(youtubeRoutes);
  await app.register(audioRoutes);
  await app.register(playlistRoutes);

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  return app;
}
