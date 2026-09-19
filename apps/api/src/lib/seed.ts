// ============================================
// DENGARKAN — Seed Script
// Auto-creates the initial user from env vars on first boot.
// ============================================

import { db, schema } from '../infrastructure/database/index.js';
import {
  findUserByUsername,
} from '../modules/auth/service.js';

export async function seedInitialUser(): Promise<void> {
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

  await db.insert(schema.users).values({ username, passwordHash });
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
