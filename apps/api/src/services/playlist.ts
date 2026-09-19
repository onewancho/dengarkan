// ============================================
// DENGARKAN — Playlist Service
// ============================================

import { eq, and, asc, count, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Playlist, PlaylistTrack } from '@dengarkan/shared';

// --- Playlists ---

export async function getUserPlaylists(userId: string): Promise<Playlist[]> {
  const rows = await db
    .select({
      id: schema.playlists.id,
      name: schema.playlists.name,
      position: schema.playlists.position,
      createdAt: schema.playlists.createdAt,
      updatedAt: schema.playlists.updatedAt,
      trackCount: count(schema.playlistTracks.id),
    })
    .from(schema.playlists)
    .leftJoin(
      schema.playlistTracks,
      eq(schema.playlists.id, schema.playlistTracks.playlistId)
    )
    .where(eq(schema.playlists.userId, userId))
    .groupBy(schema.playlists.id)
    .orderBy(asc(schema.playlists.position));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    position: r.position,
    trackCount: Number(r.trackCount),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function getPlaylistById(playlistId: string, userId: string) {
  const rows = await db
    .select()
    .from(schema.playlists)
    .where(
      and(
        eq(schema.playlists.id, playlistId),
        eq(schema.playlists.userId, userId)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function createPlaylist(
  userId: string,
  name: string
): Promise<Playlist> {
  // Get next position
  const maxPos = await db
    .select({ maxPosition: sql<number>`COALESCE(MAX(${schema.playlists.position}), -1)` })
    .from(schema.playlists)
    .where(eq(schema.playlists.userId, userId));

  const position = (maxPos[0]?.maxPosition ?? -1) + 1;

  const [row] = await db
    .insert(schema.playlists)
    .values({ userId, name, position })
    .returning();

  return {
    id: row.id,
    name: row.name,
    position: row.position,
    trackCount: 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function renamePlaylist(
  playlistId: string,
  userId: string,
  name: string
): Promise<Playlist | null> {
  const rows = await db
    .update(schema.playlists)
    .set({ name, updatedAt: new Date() })
    .where(
      and(
        eq(schema.playlists.id, playlistId),
        eq(schema.playlists.userId, userId)
      )
    )
    .returning();

  if (rows.length === 0) return null;

  const r = rows[0];
  const tc = await db
    .select({ trackCount: count(schema.playlistTracks.id) })
    .from(schema.playlistTracks)
    .where(eq(schema.playlistTracks.playlistId, playlistId));

  return {
    id: r.id,
    name: r.name,
    position: r.position,
    trackCount: Number(tc[0]?.trackCount ?? 0),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function deletePlaylist(
  playlistId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .delete(schema.playlists)
    .where(
      and(
        eq(schema.playlists.id, playlistId),
        eq(schema.playlists.userId, userId)
      )
    )
    .returning({ id: schema.playlists.id });

  return result.length > 0;
}

// --- Playlist Tracks ---

export async function getPlaylistTracks(
  playlistId: string
): Promise<PlaylistTrack[]> {
  const rows = await db
    .select()
    .from(schema.playlistTracks)
    .where(eq(schema.playlistTracks.playlistId, playlistId))
    .orderBy(asc(schema.playlistTracks.position));

  return rows.map((r) => ({
    id: r.id,
    playlistId: r.playlistId,
    videoId: r.videoId,
    title: r.title,
    channelName: r.channelName,
    thumbnailUrl: r.thumbnailUrl,
    durationSeconds: r.durationSeconds,
    position: r.position,
    addedAt: r.addedAt.toISOString(),
  }));
}

export async function addTrackToPlaylist(
  playlistId: string,
  track: {
    videoId: string;
    title: string;
    channelName: string;
    thumbnailUrl: string;
    durationSeconds: number;
  }
): Promise<PlaylistTrack> {
  // Get next position
  const maxPos = await db
    .select({
      maxPosition: sql<number>`COALESCE(MAX(${schema.playlistTracks.position}), -1)`,
    })
    .from(schema.playlistTracks)
    .where(eq(schema.playlistTracks.playlistId, playlistId));

  const position = (maxPos[0]?.maxPosition ?? -1) + 1;

  const [row] = await db
    .insert(schema.playlistTracks)
    .values({
      playlistId,
      videoId: track.videoId,
      title: track.title,
      channelName: track.channelName,
      thumbnailUrl: track.thumbnailUrl,
      durationSeconds: track.durationSeconds,
      position,
    })
    .returning();

  // Touch playlist updatedAt
  await db
    .update(schema.playlists)
    .set({ updatedAt: new Date() })
    .where(eq(schema.playlists.id, playlistId));

  return {
    id: row.id,
    playlistId: row.playlistId,
    videoId: row.videoId,
    title: row.title,
    channelName: row.channelName,
    thumbnailUrl: row.thumbnailUrl,
    durationSeconds: row.durationSeconds,
    position: row.position,
    addedAt: row.addedAt.toISOString(),
  };
}

export async function removeTrackFromPlaylist(
  playlistId: string,
  trackId: string
): Promise<boolean> {
  const result = await db
    .delete(schema.playlistTracks)
    .where(
      and(
        eq(schema.playlistTracks.id, trackId),
        eq(schema.playlistTracks.playlistId, playlistId)
      )
    )
    .returning({ id: schema.playlistTracks.id });

  if (result.length > 0) {
    await db
      .update(schema.playlists)
      .set({ updatedAt: new Date() })
      .where(eq(schema.playlists.id, playlistId));
  }

  return result.length > 0;
}

export async function reorderPlaylistTracks(
  playlistId: string,
  trackIds: string[]
): Promise<void> {
  // Update each track's position based on array index
  await db.transaction(async (tx) => {
    for (let i = 0; i < trackIds.length; i++) {
      await tx
        .update(schema.playlistTracks)
        .set({ position: i })
        .where(
          and(
            eq(schema.playlistTracks.id, trackIds[i]),
            eq(schema.playlistTracks.playlistId, playlistId)
          )
        );
    }

    await tx
      .update(schema.playlists)
      .set({ updatedAt: new Date() })
      .where(eq(schema.playlists.id, playlistId));
  });
}
