// ============================================
// DENGARKAN — Seed Script
// Auto-creates initial user from env vars on first boot
// ============================================

import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { hashPassword, findUserByUsername } from './services/auth.js';

export async function seedInitialUser(): Promise<void> {
  const username = process.env.AUTH_USERNAME;
  const passwordHash = process.env.AUTH_PASSWORD_HASH;

  if (!username) {
    console.log('[seed] AUTH_USERNAME not set, skipping user seed');
    return;
  }

  // Check if user already exists
  const existing = await findUserByUsername(username);

  if (existing) {
    console.log(`[seed] User "${username}" already exists, skipping`);
    return;
  }

  if (!passwordHash) {
    console.error('[seed] AUTH_PASSWORD_HASH not set. Generate one with:');
    console.error(
      '  node -e "import(\'argon2\').then(a => a.hash(\'YourPassword\').then(console.log))"'
    );
    return;
  }

  await db.insert(schema.users).values({
    username,
    passwordHash,
  });

  console.log(`[seed] Created initial user "${username}"`);
}

// Run directly if invoked as entrypoint
const isMain =
  process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js');

if (isMain) {
  seedInitialUser()
    .then(() => {
      console.log('[seed] Done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed] Error:', err);
      process.exit(1);
    });
}
