// ============================================
// DENGARKAN — Auth Module: Service
//
// Password hashing + session management.
// DB operations delegated to repositories.
// ============================================

import * as argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../../infrastructure/database/index.js';
import { sessionRepository } from '../../infrastructure/repositories/index.js';

// Re-export session functions that routes/middleware use
export const createSession   = sessionRepository.create.bind(sessionRepository);
export const deleteSession   = sessionRepository.delete.bind(sessionRepository);
export const validateSession = sessionRepository.find.bind(sessionRepository);
export const cleanExpiredSessions = sessionRepository.deleteExpired.bind(sessionRepository);

// ── Password ──────────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type:        argon2.argon2id,
    memoryCost:  65536, // 64 MB
    timeCost:    3,
    parallelism: 4,
  });
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export interface DevUserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: 'superadmin' | 'user';
  status: 'active' | 'suspended';
  lastLogin?: Date | null;
  lastDevice?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const DEV_USERS: Record<string, DevUserRecord> = {
  abang: {
    id: 'user-abang-001',
    username: 'abang',
    passwordHash: process.env.AUTH_PASSWORD_HASH || '$argon2id$v=19$m=65536,t=3,p=4$anGoe88fDHTDJHlJo5o5aw$0wHQ89bNFWvSSXLnq15pWnYxWEV2UsfwsuqNmi6xFaM',
    role: 'user',
    status: 'active',
    lastLogin: null,
    lastDevice: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
  user1: {
    id: 'user-demo-001',
    username: 'user1',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$acX1DE10ua3+fuMECl0RZQ$4IEE9NcuytJPIPecKqtyE6KGrGydnev1snwgnpuFC7s',
    role: 'user',
    status: 'active',
    lastLogin: null,
    lastDevice: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
  maswaw: {
    id: 'user-maswaw-001',
    username: 'maswaw',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$anGoe88fDHTDJHlJo5o5aw$0wHQ89bNFWvSSXLnq15pWnYxWEV2UsfwsuqNmi6xFaM',
    role: 'superadmin',
    status: 'active',
    lastLogin: null,
    lastDevice: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
};

export async function findUserByUsername(username: string) {
  const clean = username.trim().toLowerCase();
  try {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.username}) = ${clean}`)
      .limit(1);
    if (user) return user;
  } catch {
    // Database connection refused or offline — fall back to configured dev users
  }
  return DEV_USERS[clean] ?? DEV_USERS[username] ?? null;
}

export async function updateUserLastLoginAndDevice(userId: string, device: string): Promise<void> {
  const now = new Date();
  try {
    await db
      .update(schema.users)
      .set({
        lastLogin: now,
        lastDevice: device,
        updatedAt: now,
      })
      .where(eq(schema.users.id, userId));
  } catch {
    // Non-fatal if DB offline or in fallback mode
  }

  for (const key of Object.keys(DEV_USERS)) {
    if (DEV_USERS[key].id === userId || DEV_USERS[key].username === userId) {
      DEV_USERS[key].lastLogin = now;
      DEV_USERS[key].lastDevice = device;
      DEV_USERS[key].updatedAt = now;
    }
  }
}
