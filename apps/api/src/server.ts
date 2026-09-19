// ============================================
// DENGARKAN — Fastify Server Entry Point
// ============================================

import 'dotenv/config';
import { createApp } from './lib/app.js';
import { seedInitialUser } from './lib/seed.js';

const PORT = parseInt(process.env.API_PORT || '3001', 10);
const HOST = process.env.API_HOST || '0.0.0.0';

async function main() {
  const app = await createApp();

  // Auto-seed initial user on first boot (non-fatal if DB not ready)
  try {
    await seedInitialUser();
  } catch (err) {
    app.log.warn(
      'Auto-seed failed (DB may not be ready yet): %s',
      (err as Error)?.message
    );
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`DENGARKAN API → http://${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
