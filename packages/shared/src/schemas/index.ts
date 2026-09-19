import { z } from 'zod';

// --- Auth ---

export const loginSchema = z.object({
  username: z.string().min(1).max(50).trim(),
  password: z.string().min(1).max(128),
});

// --- Search ---

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200).trim(),
});

// --- Video ID ---

export const videoIdSchema = z.string().regex(
  /^[A-Za-z0-9_-]{11}$/,
  'Invalid YouTube video ID'
);

// --- Playlist ---

export const createPlaylistSchema = z.object({
  name: z.string().min(1).max(200).trim(),
});

export const renamePlaylistSchema = z.object({
  name: z.string().min(1).max(200).trim(),
});

export const addTrackSchema = z.object({
  videoId: videoIdSchema,
  title: z.string().min(1).max(500),
  channelName: z.string().min(1).max(200),
  thumbnailUrl: z.string().url().max(500),
  durationSeconds: z.number().int().min(0),
});

export const reorderTracksSchema = z.object({
  trackIds: z.array(z.string().uuid()).min(1),
});
