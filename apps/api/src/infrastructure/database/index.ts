// ============================================
// DENGARKAN — Database Connection (Lazy)
//
// Connection is created lazily on first use.
// This allows test environments to import this
// module without requiring DATABASE_URL when
// all DB calls are mocked out via injected services.
// ============================================

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type DB = PostgresJsDatabase<typeof schema>;

// ── Lazy singleton ────────────────────────────────────────────────────────────

let _db: DB | null = null;

function getDb(): DB {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is required. ' +
      'Set it in .env or provide it before starting the server.'
    );
  }

  const client = postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  _db = drizzle(client, { schema });
  return _db;
}

// ── Proxy: transparent lazy access ───────────────────────────────────────────
// `db.select()` etc. work exactly as before — but the connection is
// only established on first real query, not at import time.

export const db = new Proxy({} as DB, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export { schema };
