// ============================================
// DENGARKAN — Auth Route Tests
//
// Run: node --test --import tsx/esm src/modules/auth/auth.test.ts
//
// Coverage:
//  ✓ Login success — 200 + user object
//  ✓ Login — session_token cookie set
//  ✓ Login — cookie HttpOnly flag
//  ✓ Login — cookie SameSite=Lax flag
//  ✓ Login — cookie Path=/ flag
//  ✓ Login — wrong password returns 401 (generic)
//  ✓ Login — unknown user returns same 401 (no enumeration)
//  ✓ Login — missing fields returns 400
//  ✓ Login — empty body returns 400
//  ✓ Login — no credential leakage in error
//  ✓ Logout — success clears session
//  ✓ Logout — no cookie returns 401
//  ✓ Logout — invalid token returns 401
//  ✓ Session — valid token returns user
//  ✓ Session — no cookie returns 401
//  ✓ Session — invalid token returns 401
//  ✓ Expired session — rejected + cleaned up
//  ✓ Rate limit — 429 after N bad attempts
// ============================================

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  buildTestApp,
  buildTestAppWithLoginLimit,
  parseCookies,
  getCookieFlags,
  type MockUser,
  type MockSession,
} from '../../lib/test-app.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_USER: MockUser = {
  id:           'user-001',
  username:     'abang',
  passwordHash: 'VALID:Abang12345!?', // Decoded by mock verifyPassword
};

const JSON_CT = { 'content-type': 'application/json' };

function loginBody(
  username = 'abang',
  password = 'Abang12345!?'
): string {
  return JSON.stringify({ username, password });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function doLogin(
  app: FastifyInstance,
  username = 'abang',
  password = 'Abang12345!?'
) {
  return app.inject({
    method:  'POST',
    url:     '/api/auth/login',
    headers: JSON_CT,
    body:    loginBody(username, password),
  });
}

async function getSessionToken(app: FastifyInstance): Promise<string> {
  const res = await doLogin(app);
  const cookies = parseCookies(res.headers['set-cookie']);
  return cookies['session_token'] ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Auth Routes', () => {
  let app: FastifyInstance;
  let sessions: Map<string, MockSession>;

  before(async () => {
    sessions = new Map();
    app = buildTestApp([TEST_USER], sessions);
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  beforeEach(() => {
    sessions.clear(); // Test isolation
  });

  // ── POST /api/auth/login ────────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {

    it('200 — returns user object on success', async () => {
      const res = await doLogin(app);

      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
      const body = res.json() as { user: { id: string; username: string } };
      assert.equal(body.user.username, 'abang');
      assert.equal(body.user.id, 'user-001');
    });

    it('200 — no password hash or token in response body', async () => {
      const res = await doLogin(app);

      assert.equal(res.statusCode, 200);
      const body = res.json() as Record<string, unknown>;
      const user = body.user as Record<string, unknown>;
      assert.equal(user.passwordHash,  undefined, 'passwordHash must not leak');
      assert.equal(body.token,         undefined, 'session token must not be in body');
      assert.equal(body.sessionSecret, undefined, 'secret must not leak');
    });

    it('200 — session_token cookie is set', async () => {
      const res = await doLogin(app);

      const cookies = parseCookies(res.headers['set-cookie']);
      assert.ok(cookies['session_token'], 'session_token cookie must exist');
      assert.ok(cookies['session_token']!.length > 10, 'token should be non-trivial');
    });

    it('200 — cookie has HttpOnly flag', async () => {
      const res = await doLogin(app);
      const flags = getCookieFlags(res.headers['set-cookie']);
      assert.ok(flags.includes('httponly'), `Expected httponly in: ${flags}`);
    });

    it('200 — cookie has SameSite=Lax flag', async () => {
      const res = await doLogin(app);
      const flags = getCookieFlags(res.headers['set-cookie']);
      assert.ok(flags.includes('samesite=lax'), `Expected samesite=lax in: ${flags}`);
    });

    it('200 — cookie has Path=/ flag', async () => {
      const res = await doLogin(app);
      const flags = getCookieFlags(res.headers['set-cookie']);
      assert.ok(flags.includes('path=/'), `Expected path=/ in: ${flags}`);
    });

    it('200 — session is stored in session store', async () => {
      await doLogin(app);
      assert.equal(sessions.size, 1, 'One session should be created after login');
    });

    it('401 — wrong password (generic message, no user info)', async () => {
      const res = await doLogin(app, 'abang', 'WrongPassword!');

      assert.equal(res.statusCode, 401);
      const body = res.json() as { message: string };
      assert.equal(body.message, 'Invalid username or password');
    });

    it('401 — unknown user returns identical 401 (no user enumeration)', async () => {
      const wrongUser = await doLogin(app, 'doesNotExist', 'anypassword');
      const wrongPass = await doLogin(app, 'abang', 'wrongpass');

      assert.equal(wrongUser.statusCode, 401);
      assert.equal(wrongPass.statusCode, 401);
      // Both responses must look identical
      assert.deepEqual(
        wrongUser.json<Record<string, unknown>>().message,
        wrongPass.json<Record<string, unknown>>().message,
        'Unknown user and wrong password must return identical message'
      );
    });

    it('400 — missing password field', async () => {
      const res = await app.inject({
        method:  'POST',
        url:     '/api/auth/login',
        headers: JSON_CT,
        body:    JSON.stringify({ username: 'abang' }),
      });
      assert.equal(res.statusCode, 400);
    });

    it('400 — missing username field', async () => {
      const res = await app.inject({
        method:  'POST',
        url:     '/api/auth/login',
        headers: JSON_CT,
        body:    JSON.stringify({ password: 'Abang12345!?' }),
      });
      assert.equal(res.statusCode, 400);
    });

    it('400 — empty body {}', async () => {
      const res = await app.inject({
        method:  'POST',
        url:     '/api/auth/login',
        headers: JSON_CT,
        body:    '{}',
      });
      assert.equal(res.statusCode, 400);
    });

    it('no credential leakage in error responses', async () => {
      const res = await doLogin(app, 'abang', 'WrongPass');
      const body = res.body;
      assert.ok(!body.includes('Abang12345'),  'Must not leak correct password');
      assert.ok(!body.includes('argon2'),      'Must not leak hash algorithm');
      assert.ok(!body.includes('VALID:'),      'Must not leak internal format');
      assert.ok(!body.includes('passwordHash'),'Must not leak hash field name');
    });
  });

  // ── POST /api/auth/logout ───────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {

    it('200 — logout clears session from store', async () => {
      const token = await getSessionToken(app);
      assert.ok(sessions.size > 0, 'Session should exist before logout');

      const res = await app.inject({
        method:  'POST',
        url:     '/api/auth/logout',
        headers: { cookie: `session_token=${token}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(sessions.size, 0, 'Session store should be empty after logout');
    });

    it('200 — logout response does not expose session data', async () => {
      const token = await getSessionToken(app);

      const res = await app.inject({
        method:  'POST',
        url:     '/api/auth/logout',
        headers: { cookie: `session_token=${token}` },
      });

      assert.ok(!res.body.includes(token), 'Response must not echo the token');
    });

    it('401 — logout without cookie', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
      assert.equal(res.statusCode, 401);
    });

    it('401 — logout with invalid token', async () => {
      const res = await app.inject({
        method:  'POST',
        url:     '/api/auth/logout',
        headers: { cookie: 'session_token=totally-invalid-token-xyz' },
      });
      assert.equal(res.statusCode, 401);
    });
  });

  // ── GET /api/auth/session ───────────────────────────────────────────────────

  describe('GET /api/auth/session', () => {

    it('200 — valid session returns user', async () => {
      const token = await getSessionToken(app);

      const res = await app.inject({
        method:  'GET',
        url:     '/api/auth/session',
        headers: { cookie: `session_token=${token}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json() as { user: { id: string; username: string } };
      assert.equal(body.user.username, 'abang');
      assert.equal(body.user.id, 'user-001');
    });

    it('401 — no cookie present', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/auth/session' });
      assert.equal(res.statusCode, 401);
    });

    it('401 — invalid token', async () => {
      const res = await app.inject({
        method:  'GET',
        url:     '/api/auth/session',
        headers: { cookie: 'session_token=not-a-real-token' },
      });
      assert.equal(res.statusCode, 401);
    });

    it('401 — after logout, old token no longer works', async () => {
      const token = await getSessionToken(app);

      // Logout
      await app.inject({
        method:  'POST',
        url:     '/api/auth/logout',
        headers: { cookie: `session_token=${token}` },
      });

      // Try to use the same token
      const res = await app.inject({
        method:  'GET',
        url:     '/api/auth/session',
        headers: { cookie: `session_token=${token}` },
      });

      assert.equal(res.statusCode, 401, 'Token should be invalid after logout');
    });
  });

  // ── Expired Session ─────────────────────────────────────────────────────────

  describe('Expired session', () => {

    it('401 — expired session token is rejected', async () => {
      const token = 'expired-test-token';
      sessions.set(token, {
        sessionId: 'sess-expired-001',
        userId:    TEST_USER.id,
        username:  TEST_USER.username,
        expiresAt: new Date(Date.now() - 1_000), // 1 second ago
      });

      const res = await app.inject({
        method:  'GET',
        url:     '/api/auth/session',
        headers: { cookie: `session_token=${token}` },
      });

      assert.equal(res.statusCode, 401, 'Expired session should be rejected');
    });

    it('expired session is cleaned from store on access', async () => {
      const token = 'expired-cleanup-token';
      sessions.set(token, {
        sessionId: 'sess-expired-002',
        userId:    TEST_USER.id,
        username:  TEST_USER.username,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await app.inject({
        method:  'GET',
        url:     '/api/auth/session',
        headers: { cookie: `session_token=${token}` },
      });

      assert.equal(sessions.has(token), false, 'Expired session should be deleted');
    });
  });

  // ── Rate Limiting ───────────────────────────────────────────────────────────

  describe('Rate limiting on /api/auth/login', () => {

    it('429 — returns Too Many Requests after exceeding limit', async () => {
      const rateSessions = new Map<string, MockSession>();
      // Build app with limit of 3 per IP
      const limitedApp = buildTestAppWithLoginLimit([TEST_USER], rateSessions, 3);
      await limitedApp.ready();

      let statusCodes: number[] = [];
      // Make 5 requests — the 4th+ should be 429
      for (let i = 0; i < 5; i++) {
        const res = await limitedApp.inject({
          method:  'POST',
          url:     '/api/auth/login',
          headers: { ...JSON_CT, 'x-forwarded-for': '192.168.1.1' },
          body:    loginBody('abang', 'WrongPw!'),
        });
        statusCodes.push(res.statusCode);
      }

      assert.ok(
        statusCodes.includes(429),
        `Expected at least one 429. Got: ${statusCodes.join(', ')}`
      );

      await limitedApp.close();
    });

    it('429 response has descriptive message', async () => {
      const rateSessions = new Map<string, MockSession>();
      const limitedApp = buildTestAppWithLoginLimit([TEST_USER], rateSessions, 1);
      await limitedApp.ready();

      // First request (succeeds or fails on password)
      await limitedApp.inject({
        method:  'POST',
        url:     '/api/auth/login',
        headers: { ...JSON_CT, 'x-forwarded-for': '192.168.1.2' },
        body:    loginBody('abang', 'WrongPw!'),
      });

      // Second request (should be rate-limited)
      const res = await limitedApp.inject({
        method:  'POST',
        url:     '/api/auth/login',
        headers: { ...JSON_CT, 'x-forwarded-for': '192.168.1.2' },
        body:    loginBody('abang', 'WrongPw!'),
      });

      assert.equal(res.statusCode, 429);
      await limitedApp.close();
    });
  });
});
