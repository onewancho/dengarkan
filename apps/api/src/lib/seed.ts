// ============================================
// DENGARKAN — Seed Script
// Auto-creates the initial user from env vars on first boot.
// ============================================

import { sql } from 'drizzle-orm';
import { db, schema } from '../infrastructure/database/index.js';
import {
  findUserByUsername,
} from '../modules/auth/service.js';

export async function runAutoMigrations(): Promise<void> {
  try {
    await db.execute(sql`
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" varchar(20) DEFAULT 'user' NOT NULL;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "status" varchar(20) DEFAULT 'active' NOT NULL;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login" timestamp with time zone;
      ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_device" varchar(255);
    `);
    console.log('[migration] Users schema columns verified/updated');
  } catch (err) {
    console.warn('[migration] Auto-migration skipped (non-fatal):', (err as Error)?.message);
  }
}

export async function seedInitialUser(): Promise<void> {
  await runAutoMigrations();

  // Ensure super admin 'maswaw' exists in DB
  try {
    const existingMaswaw = await findUserByUsername('maswaw');
    if (!existingMaswaw) {
      await db.insert(schema.users).values({
        username: 'maswaw',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$anGoe88fDHTDJHlJo5o5aw$0wHQ89bNFWvSSXLnq15pWnYxWEV2UsfwsuqNmi6xFaM',
        role: 'superadmin',
        status: 'active',
      });
      console.log('[seed] Created super admin user "maswaw"');
    }
  } catch (err) {
    console.warn('[seed] Could not seed maswaw (non-fatal):', (err as Error)?.message);
  }

  const username = process.env.AUTH_USERNAME;
  const passwordHash = process.env.AUTH_PASSWORD_HASH;

  if (!username) {
    console.log('[seed] AUTH_USERNAME not set — skipping');
    return;
  }

  const existing = await findUserByUsername(username);
  if (existing) {
    console.log(`[seed] User "${username}" already exists — skipping`);
    return;
  }

  if (!passwordHash) {
    console.error(
      '[seed] AUTH_PASSWORD_HASH not set. Generate with:\n' +
      '  node -e "import(\'argon2\').then(a => a.hash(\'YourPassword\').then(console.log))"'
    );
    return;
  }

  await db.insert(schema.users).values({ username, passwordHash, role: 'user', status: 'active' });
  console.log(`[seed] Created user "${username}"`);
}

// Run directly when invoked as entrypoint
const isMain =
  process.argv[1]?.endsWith('seed.ts') ||
  process.argv[1]?.endsWith('seed.js');

if (isMain) {
  seedInitialUser()
    .then(() => { console.log('[seed] Done'); process.exit(0); })
    .catch((err) => { console.error('[seed] Error:', err); process.exit(1); });
}
