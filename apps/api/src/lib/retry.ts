// ============================================
// DENGARKAN — Stream Refresh: Retry Utility
//
// Exponential backoff retry for transient errors.
// Used by the resolver when yt-dlp returns a
// NETWORK_ERROR or RATE_LIMITED error.
//
// Policy:
//   • NETWORK_ERROR → retry (Wi-Fi drop, timeout, cellular handoff)
//   • RATE_LIMITED  → retry with longer backoff
//   • All others    → fail immediately (no retry)
//
// Max 3 attempts total (initial + 2 retries).
// Delays: 1s → 2s (jittered ±20%).
// Total max wait before giving up: ~5s.
// ============================================

import { ResolverError, type ResolverErrorCode } from '../modules/audio/errors.js';

// Codes that are worth retrying (transient)
const RETRYABLE: Set<ResolverErrorCode> = new Set([
  'NETWORK_ERROR',
  'RATE_LIMITED',
]);

export interface RetryOptions {
  maxAttempts?: number;     // Total attempts (default 3)
  baseDelayMs?:  number;    // First retry delay ms (default 1000)
  maxDelayMs?:   number;    // Cap per-attempt delay ms (default 8000)
  jitter?:       number;    // Fraction ±jitter applied to delay (default 0.2)
}

/**
 * Run `fn` with exponential backoff, retrying only on retryable ResolverErrors.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs  = 1_000,
    maxDelayMs   = 8_000,
    jitter       = 0.2,
  } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      // Non-resolver errors (programming errors etc.) — bail immediately
      if (!(err instanceof ResolverError)) throw err;

      // Non-retryable resolver errors — bail immediately
      const resolverErr = err as ResolverError;
      if (!RETRYABLE.has(resolverErr.code)) throw resolverErr;

      // Last attempt — don't wait, just rethrow
      if (attempt === maxAttempts) break;

      // Exponential backoff with jitter
      const base  = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const noise = base * jitter;
      const delay = base + (Math.random() * noise * 2 - noise); // ±jitter
      await sleep(Math.round(delay));
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
