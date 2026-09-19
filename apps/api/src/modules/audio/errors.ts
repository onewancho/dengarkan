// ============================================
// DENGARKAN — Audio Resolver Errors
//
// Structured error hierarchy for the audio resolver.
// Each error code maps to a specific HTTP status in routes.ts.
//
// Limitations of yt-dlp / YouTube (documented):
//   • YouTube CDN stream URLs expire — typically 6h but can be shorter.
//     Use /api/audio/refresh when a URL returns 403.
//   • Age-restricted and login-required videos cannot be resolved
//     without YouTube authentication cookies (not implemented).
//   • Live streams: yt-dlp returns a manifest URL, not a direct audio URL.
//     Live audio is NOT supported in this implementation.
//   • Private/deleted videos produce VIDEO_NOT_FOUND or VIDEO_UNAVAILABLE.
//   • yt-dlp itself may be rate-limited by YouTube; errors are surfaced as
//     RATE_LIMITED. Backoff and retry should be done at the application level.
//   • Some geo-blocked videos may appear as VIDEO_UNAVAILABLE.
//   • Format availability varies: M4A/AAC is preferred for Safari. If only
//     Opus/WebM is available, UNSUPPORTED_FORMAT is thrown because Safari
//     cannot play WebM natively (as of iOS 17).
// ============================================

export type ResolverErrorCode =
  | 'VIDEO_NOT_FOUND'
  | 'VIDEO_UNAVAILABLE'
  | 'NO_AUDIO_STREAM'
  | 'UNSUPPORTED_FORMAT'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'RESOLVER_FAILED';

/**
 * Structured error thrown by the audio resolver.
 * Routes map these to specific HTTP status codes.
 */
export class ResolverError extends Error {
  constructor(
    public readonly code: ResolverErrorCode,
    message: string,
    /** Original error, if any, for internal logging */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResolverError';
  }
}

/** Map ResolverErrorCode → HTTP status */
export const resolverErrorStatus: Record<ResolverErrorCode, number> = {
  VIDEO_NOT_FOUND:    404,
  VIDEO_UNAVAILABLE:  422,
  NO_AUDIO_STREAM:    422,
  UNSUPPORTED_FORMAT: 422,
  RATE_LIMITED:       429,
  NETWORK_ERROR:      502,
  RESOLVER_FAILED:    500,
};

/** Map ResolverErrorCode → user-facing message */
export const resolverErrorMessage: Record<ResolverErrorCode, string> = {
  VIDEO_NOT_FOUND:    'Video not found. It may have been deleted or made private.',
  VIDEO_UNAVAILABLE:  'Video is unavailable in this region or requires sign-in.',
  NO_AUDIO_STREAM:    'No audio stream available for this video.',
  UNSUPPORTED_FORMAT: 'No browser-compatible audio format available for this video.',
  RATE_LIMITED:       'Too many requests. Please try again in a few moments.',
  NETWORK_ERROR:      'Network error while fetching audio stream.',
  RESOLVER_FAILED:    'Failed to resolve audio stream. Please try again.',
};
