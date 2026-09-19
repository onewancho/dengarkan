// ============================================
// DENGARKAN — Auth Service
// ============================================

import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { eq, and, gt, lt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return argon2.verify(hash, password);
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
}

export async function findUserByUsername(username: string) {
  const result = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1);
  return result[0] ?? null;
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(schema.sessions).values({
    userId,
    token,
    expiresAt,
  });

  return token;
}

export async function validateSession(token: string) {
  const result = await db
    .select({
      sessionId: schema.sessions.id,
      userId: schema.sessions.userId,
      username: schema.users.username,
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

  return result[0] ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await db
    .delete(schema.sessions)
    .where(eq(schema.sessions.token, token));
}

export async function cleanExpiredSessions(): Promise<void> {
  await db
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, new Date()));
}
