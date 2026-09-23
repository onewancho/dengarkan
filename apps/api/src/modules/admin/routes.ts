// ============================================
// DENGARKAN — Admin Module: Routes
//
// Super Admin Account Management endpoints:
//   • GET    /api/admin/users     — List all users with lastLogin & lastDevice
//   • POST   /api/admin/users     — Create new user (Argon2id password hashing)
//   • PATCH  /api/admin/users/:id — Update status/role/device or reset password
//   • DELETE /api/admin/users/:id — Delete user (protected against deleting maswaw)
//
// Protected strictly for 'maswaw' / superadmin role.
// ============================================

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../../infrastructure/database/index.js';
import { authMiddleware } from '../../middleware/auth.js';
import { hashPassword, DEV_USERS, findUserByUsername } from '../auth/service.js';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // 1. All admin routes require a valid session
  app.addHook('preHandler', authMiddleware);

  // 2. Strict Super Admin guard: only 'maswaw' is permitted
  app.addHook('preHandler', async (request, reply) => {
    const currentUsername = request.username?.toLowerCase();
    if (currentUsername !== 'maswaw') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Akses ditolak: Hanya Super Admin (maswaw) yang dapat mengakses area ini.',
        statusCode: 403,
      });
    }
  });

  // ── GET /api/admin/users ──────────────────────────────────────────────────
  app.get('/api/admin/users', async (_request, reply) => {
    try {
      const dbUsers = await db
        .select({
          id: schema.users.id,
          username: schema.users.username,
          role: schema.users.role,
          status: schema.users.status,
          lastLogin: schema.users.lastLogin,
          lastDevice: schema.users.lastDevice,
          createdAt: schema.users.createdAt,
        })
        .from(schema.users)
        .orderBy(desc(schema.users.createdAt));

      if (dbUsers && dbUsers.length > 0) {
        return reply.status(200).send({ users: dbUsers });
      }
    } catch (err) {
      app.log.warn('Could not read users from DB (falling back to dev users): %s', (err as Error)?.message);
    }

    // In-memory / dev fallback if DB has no rows or is offline
    const fallbackList = Object.values(DEV_USERS).map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      status: u.status,
      lastLogin: u.lastLogin ?? null,
      lastDevice: u.lastDevice ?? null,
      createdAt: u.createdAt,
    }));

    return reply.status(200).send({ users: fallbackList });
  });

  // ── POST /api/admin/users ─────────────────────────────────────────────────
  app.post('/api/admin/users', async (request, reply) => {
    const body = request.body as Record<string, string> | undefined;
    if (!body || !body.username || !body.password) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Username dan password wajib diisi.',
        statusCode: 400,
      });
    }

    const username = body.username.trim();
    const password = body.password;
    const role = (body.role === 'superadmin' ? 'superadmin' : 'user') as 'superadmin' | 'user';
    const status = (body.status === 'suspended' ? 'suspended' : 'active') as 'active' | 'suspended';
    const device = body.device?.trim() || 'Belum ada perangkat';

    // Check duplicate
    const existing = await findUserByUsername(username);
    if (existing) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: `Username "${username}" sudah digunakan.`,
        statusCode: 400,
      });
    }

    // Hash password with Argon2id on the backend
    const passwordHash = await hashPassword(password);
    const now = new Date();

    try {
      const [created] = await db
        .insert(schema.users)
        .values({
          username,
          passwordHash,
          role,
          status,
          lastDevice: device,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: schema.users.id,
          username: schema.users.username,
          role: schema.users.role,
          status: schema.users.status,
          lastLogin: schema.users.lastLogin,
          lastDevice: schema.users.lastDevice,
          createdAt: schema.users.createdAt,
        });

      if (created) {
        // Also register in DEV_USERS in-memory fallback
        DEV_USERS[username] = {
          id: created.id,
          username: created.username,
          passwordHash,
          role,
          status,
          lastLogin: null,
          lastDevice: device,
          createdAt: now,
          updatedAt: now,
        };

        return reply.status(201).send({ user: created });
      }
    } catch (err) {
      app.log.warn('Could not insert user into DB (using dev fallback): %s', (err as Error)?.message);
    }

    // In-memory fallback
    const fallbackId = `user-${Date.now()}`;
    const fallbackUser = {
      id: fallbackId,
      username,
      passwordHash,
      role,
      status,
      lastLogin: null,
      lastDevice: device,
      createdAt: now,
      updatedAt: now,
    };
    DEV_USERS[username] = fallbackUser;

    return reply.status(201).send({
      user: {
        id: fallbackId,
        username,
        role,
        status,
        lastLogin: null,
        lastDevice: device,
        createdAt: now,
      },
    });
  });

  // ── PATCH /api/admin/users/:id ────────────────────────────────────────────
  app.patch('/api/admin/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, string> | undefined;

    if (!id || !body) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Invalid request data.',
        statusCode: 400,
      });
    }

    // Find in memory or DB
    let targetUsername: string | null = null;
    for (const key of Object.keys(DEV_USERS)) {
      if (DEV_USERS[key].id === id || DEV_USERS[key].username === id) {
        targetUsername = DEV_USERS[key].username;
        break;
      }
    }

    // Guard: Prevent suspending maswaw
    if (targetUsername?.toLowerCase() === 'maswaw' && body.status === 'suspended') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Akun Super Admin utama (maswaw) tidak dapat ditangguhkan.',
        statusCode: 400,
      });
    }

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (body.username && body.username.trim()) {
      updates.username = body.username.trim();
    }
    if (body.role === 'user' || body.role === 'superadmin') {
      updates.role = body.role;
    }
    if (body.status === 'active' || body.status === 'suspended') {
      updates.status = body.status;
    }
    if (body.device) {
      updates.lastDevice = body.device.trim();
    }
    if (body.password && body.password.trim()) {
      updates.passwordHash = await hashPassword(body.password.trim());
    }

    try {
      const [updated] = await db
        .update(schema.users)
        .set(updates)
        .where(eq(schema.users.id, id))
        .returning({
          id: schema.users.id,
          username: schema.users.username,
          role: schema.users.role,
          status: schema.users.status,
          lastLogin: schema.users.lastLogin,
          lastDevice: schema.users.lastDevice,
          createdAt: schema.users.createdAt,
        });

      if (updated) {
        if (targetUsername && DEV_USERS[targetUsername]) {
          Object.assign(DEV_USERS[targetUsername], updates);
        }
        return reply.status(200).send({ user: updated });
      }
    } catch (err) {
      app.log.warn('Could not update user in DB: %s', (err as Error)?.message);
    }

    // Fallback update in memory
    if (targetUsername && DEV_USERS[targetUsername]) {
      Object.assign(DEV_USERS[targetUsername], updates);
      const u = DEV_USERS[targetUsername];
      return reply.status(200).send({
        user: {
          id: u.id,
          username: u.username,
          role: u.role,
          status: u.status,
          lastLogin: u.lastLogin ?? null,
          lastDevice: u.lastDevice ?? null,
          createdAt: u.createdAt,
        },
      });
    }

    return reply.status(404).send({
      error: 'Not Found',
      message: 'User tidak ditemukan.',
      statusCode: 404,
    });
  });

  // ── DELETE /api/admin/users/:id ───────────────────────────────────────────
  app.delete('/api/admin/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Prevent deleting maswaw
    let targetUsername: string | null = null;
    for (const key of Object.keys(DEV_USERS)) {
      if (DEV_USERS[key].id === id || DEV_USERS[key].username === id) {
        targetUsername = DEV_USERS[key].username;
        break;
      }
    }

    if (id === 'user-maswaw-001' || targetUsername?.toLowerCase() === 'maswaw') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Akun Super Admin utama (maswaw) tidak dapat dihapus.',
        statusCode: 400,
      });
    }

    try {
      // Cascade delete sessions first
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    } catch (err) {
      app.log.warn('Could not delete user from DB: %s', (err as Error)?.message);
    }

    if (targetUsername && DEV_USERS[targetUsername]) {
      delete DEV_USERS[targetUsername];
    }

    return reply.status(200).send({ success: true, message: 'Akun berhasil dihapus.' });
  });
};
