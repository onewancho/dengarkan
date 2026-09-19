// ============================================
// DENGARKAN — Database Schema (Drizzle ORM)
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

// --- Users ---

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: varchar('username', { length: 50 }).notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex('idx_users_username').on(table.username)]
);

// --- Sessions ---

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: varchar('token', { length: 255 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_sessions_token').on(table.token),
    index('idx_sessions_user_id').on(table.userId),
    index('idx_sessions_expires_at').on(table.expiresAt),
  ]
);

// --- Playlists ---

export const playlists = pgTable(
  'playlists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 200 }).notNull(),
    position: integer('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index('idx_playlists_user_id').on(table.userId)]
);

// --- Playlist Tracks ---

export const playlistTracks = pgTable(
  'playlist_tracks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    videoId: varchar('video_id', { length: 11 }).notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    channelName: varchar('channel_name', { length: 200 }).notNull(),
    thumbnailUrl: varchar('thumbnail_url', { length: 500 }).notNull(),
    durationSeconds: integer('duration_seconds').notNull().default(0),
    position: integer('position').notNull().default(0),
    addedAt: timestamp('added_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_pt_playlist_id').on(table.playlistId),
    index('idx_pt_playlist_position').on(table.playlistId, table.position),
    index('idx_pt_video_id').on(table.videoId),
  ]
);

// --- Audio Cache (optional persistent cache) ---

export const audioCache = pgTable('audio_cache', {
  videoId: varchar('video_id', { length: 11 }).primaryKey(),
  streamUrl: text('stream_url').notNull(),
  mimeType: varchar('mime_type', { length: 50 }).notNull(),
  codec: varchar('codec', { length: 50 }).notNull(),
  bitrate: integer('bitrate').notNull(),
  sampleRate: integer('sample_rate').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  title: varchar('title', { length: 500 }).notNull(),
  channelName: varchar('channel_name', { length: 200 }).notNull(),
  thumbnailUrl: varchar('thumbnail_url', { length: 500 }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});
