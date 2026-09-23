// ============================================
// DENGARKAN — Database Schema (Drizzle ORM)
//
// Tables:
//   users           — single-user auth
//   sessions        — server-side session tokens
//   playlists       — user playlists with ordering
//   playlist_tracks — tracks inside playlists
//   audio_cache     — yt-dlp resolution metadata (URL + TTL, no binary)
//
// Design decisions:
//   • audio_cache uses video_id as PK (one live URL per video at a time)
//   • expiresAt on audio_cache is Unix epoch ms (bigint) — avoids TZ issues
//     with Google Video CDN expiry parsing
//   • playlist_tracks.position is zero-based integer — reorder via bulk update
//   • All timestamps withTimezone for correctness across regions
//   • Cascades: deleting a user wipes sessions + playlists + tracks
// ============================================

import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  integer,
  text,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ── users ─────────────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id:           uuid('id').defaultRandom().primaryKey(),
    username:     varchar('username',      { length: 50  }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    role:         varchar('role',          { length: 20  }).default('user').notNull(),
    status:       varchar('status',        { length: 20  }).default('active').notNull(),
    lastLogin:    timestamp('last_login',  { withTimezone: true }),
    lastDevice:   varchar('last_device',   { length: 255 }),
    createdAt:    timestamp('created_at',  { withTimezone: true }).defaultNow().notNull(),
    updatedAt:    timestamp('updated_at',  { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_users_username').on(t.username),
  ]
);

// ── sessions ──────────────────────────────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id:        uuid('id').defaultRandom().primaryKey(),
    userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    token:     varchar('token', { length: 128 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_sessions_token').on(t.token),         // fast session lookup
    index('idx_sessions_user_id').on(t.userId),             // list/delete user sessions
    index('idx_sessions_expires_at').on(t.expiresAt),       // expired session cleanup
  ]
);

// ── playlists ─────────────────────────────────────────────────────────────────

export const playlists = pgTable(
  'playlists',
  {
    id:        uuid('id').defaultRandom().primaryKey(),
    userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name:      varchar('name', { length: 200 }).notNull(),
    position:  integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_playlists_user_id').on(t.userId),            // list user playlists
    index('idx_playlists_user_position').on(t.userId, t.position), // ordered list
  ]
);

// ── playlist_tracks ───────────────────────────────────────────────────────────

export const playlistTracks = pgTable(
  'playlist_tracks',
  {
    id:              uuid('id').defaultRandom().primaryKey(),
    playlistId:      uuid('playlist_id').notNull().references(() => playlists.id, { onDelete: 'cascade' }),
    videoId:         varchar('video_id',       { length: 11  }).notNull(),
    title:           varchar('title',          { length: 500 }).notNull(),
    channelName:     varchar('channel_name',   { length: 200 }).notNull(),
    thumbnailUrl:    varchar('thumbnail_url',  { length: 500 }).notNull(),
    durationSeconds: integer('duration_seconds').notNull().default(0),
    position:        integer('position').notNull().default(0),
    addedAt:         timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_pt_playlist_id').on(t.playlistId),                   // all tracks in playlist
    index('idx_pt_playlist_position').on(t.playlistId, t.position), // ordered track list (critical)
    index('idx_pt_video_id').on(t.videoId),                         // "is this video in any playlist?"
  ]
);

// ── audio_cache ───────────────────────────────────────────────────────────────
//
// Stores yt-dlp resolved stream metadata (URL + audio info) — no binary data.
//
// TTL strategy:
//   • expiresAt = MIN(actual stream expiry from ?expire= param, resolvedAt + MAX_CACHE_MS)
//   • MAX_CACHE_MS = 5 hours (Google CDN URLs typically expire in 6h)
//   • Resolver reads expiresAt and treats entries as invalid 5 minutes early
//     to guard against clock skew / network latency
//
// videoId is the primary key — only one live URL per video at a time.
// When a URL expires, the row is overwritten by the resolver.

export const audioCache = pgTable(
  'audio_cache',
  {
    videoId:         varchar('video_id',       { length: 11  }).primaryKey(),
    streamUrl:       text('stream_url').notNull(),
    mimeType:        varchar('mime_type',      { length: 50  }).notNull(),
    codec:           varchar('codec',          { length: 50  }).notNull(),
    bitrate:         integer('bitrate').notNull(),
    sampleRate:      integer('sample_rate').notNull(),
    durationSeconds: integer('duration_seconds').notNull(),
    title:           varchar('title',          { length: 500 }).notNull(),
    channelName:     varchar('channel_name',   { length: 200 }).notNull(),
    thumbnailUrl:    varchar('thumbnail_url',  { length: 500 }).notNull(),
    // Unix epoch ms — avoids TZ conversion issues when parsing Google CDN ?expire= params
    expiresAt:       bigint('expires_at', { mode: 'number' }).notNull(),
    resolvedAt:      timestamp('resolved_at',  { withTimezone: true }).defaultNow().notNull(),
    updatedAt:       timestamp('updated_at',   { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('idx_audio_cache_expires_at').on(t.expiresAt), // fast expired-entry cleanup
  ]
);
