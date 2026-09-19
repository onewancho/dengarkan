// ============================================
// DENGARKAN — Session Repository
// ============================================

import { eq, and, gt, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, schema } from '../database/index.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Session shape ─────────────────────────────────────────────────────────────

export interface SessionRecord {
  sessionId: string;
  userId:    string;
  username:  string;
  expiresAt: Date;
}

// ── Repository Interface ──────────────────────────────────────────────────────

export interface SessionRepository {
  create(userId: string): Promise<string>;
  find(token: string): Promise<SessionRecord | null>;
  delete(token: string): Promise<void>;
  deleteExpired(): Promise<number>;
}

// ── Implementation with DB + In-Memory Fallback ──────────────────────────────

const memSessions = new Map<string, SessionRecord>();

export const sessionRepository: SessionRepository = {
  async create(userId) {
    const token     = randomBytes(48).toString('hex'); // 96-char hex
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    try {
      await db.insert(schema.sessions).values({ userId, token, expiresAt });
      return token;
    } catch {
      // In-memory fallback if DB is offline
      const username = userId.includes('abang') ? 'abang' : 'user1';
      memSessions.set(token, { sessionId: token, userId, username, expiresAt });
      return token;
    }
  },

  async find(token) {
    try {
      const [row] = await db
        .select({
          sessionId: schema.sessions.id,
          userId:    schema.sessions.userId,
          username:  schema.users.username,
          expiresAt: schema.sessions.expiresAt,
        })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
        .where(
          and(
            eq(schema.sessions.token, token),
            gt(schema.sessions.expiresAt, new Date())
          )
        )
        .limit(1);

      if (row) return row;
    } catch {
      // In-memory fallback
    }

    const mem = memSessions.get(token);
    if (mem && mem.expiresAt > new Date()) {
      return mem;
    }
    return null;
  },

  async delete(token) {
    try {
      await db
        .delete(schema.sessions)
        .where(eq(schema.sessions.token, token));
    } catch {
      // In-memory fallback
    }
    memSessions.delete(token);
  },

  async deleteExpired() {
    let count = 0;
    try {
      const result = await db
        .delete(schema.sessions)
        .where(lt(schema.sessions.expiresAt, new Date()))
        .returning({ id: schema.sessions.id });
      count = result.length;
    } catch {
      // In-memory fallback
    }

    const now = new Date();
    for (const [token, s] of memSessions.entries()) {
      if (s.expiresAt <= now) {
        memSessions.delete(token);
        count++;
      }
    }
    return count;
  },
};
