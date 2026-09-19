// ============================================
// DENGARKAN — Playlist Repository
//
// All playlist + track DB queries live here.
// Routes/services import from this file only —
// no raw Drizzle calls outside infrastructure/.
// ============================================

import { eq, and, asc, count, sql } from 'drizzle-orm';
import { db, schema } from '../database/index.js';
import type { Playlist, PlaylistTrack } from '@dengarkan/shared';

// ── Types ─────────────────────────────────────────────────────────────────────

export type NewTrack = Pick<
  PlaylistTrack,
  'videoId' | 'title' | 'channelName' | 'thumbnailUrl' | 'durationSeconds'
>;

// ── In-Memory Fallback Store (for dev when DB is offline) ────────────────────

interface MemPlaylist {
  id: string;
  userId: string;
  name: string;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MemTrack {
  id: string;
  playlistId: string;
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number;
  position: number;
  addedAt: Date;
}

class InMemoryPlaylistStore {
  playlists = new Map<string, MemPlaylist>();
  tracks    = new Map<string, MemTrack>();
  private idCounter = 0;

  constructor() {
    this.seedDevUser('user-abang-001');
    this.seedDevUser('user-demo-001');
  }

  private seedDevUser(userId: string) {
    const pId = `pl-${userId}-fav`;
    const pl: MemPlaylist = {
      id: pId,
      userId,
      name: 'Favorit',
      position: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.playlists.set(pId, pl);
    const t: MemTrack = {
      id: `tr-${userId}-1`,
      playlistId: pId,
      videoId: 'jfKfPfyJRdk',
      title: 'lofi hip hop radio - beats to relax/study to',
      channelName: 'Lofi Girl',
      thumbnailUrl: 'https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg',
      durationSeconds: 0,
      position: 0,
      addedAt: new Date(),
    };
    this.tracks.set(t.id, t);
  }

  nextId() { return `id-${Date.now()}-${++this.idCounter}`; }

  listPlaylists(userId: string): Playlist[] {
    return [...this.playlists.values()]
      .filter(p => p.userId === userId)
      .sort((a, b) => a.position - b.position)
      .map(p => ({
        id: p.id,
        name: p.name,
        position: p.position,
        trackCount: [...this.tracks.values()].filter(t => t.playlistId === p.id).length,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      }));
  }

  findPlaylist(id: string, userId: string): Playlist | null {
    const p = this.playlists.get(id);
    if (!p || p.userId !== userId) return null;
    const trackCount = [...this.tracks.values()].filter(t => t.playlistId === id).length;
    return {
      id: p.id,
      name: p.name,
      position: p.position,
      trackCount,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  createPlaylist(userId: string, name: string): Playlist {
    const positions = [...this.playlists.values()]
      .filter(p => p.userId === userId)
      .map(p => p.position);
    const position = positions.length > 0 ? Math.max(...positions) + 1 : 0;
    const pl: MemPlaylist = {
      id: this.nextId(), userId, name, position,
      createdAt: new Date(), updatedAt: new Date(),
    };
    this.playlists.set(pl.id, pl);
    return {
      id: pl.id,
      name: pl.name,
      position: pl.position,
      trackCount: 0,
      createdAt: pl.createdAt.toISOString(),
      updatedAt: pl.updatedAt.toISOString(),
    };
  }

  renamePlaylist(id: string, userId: string, name: string): Playlist | null {
    const p = this.playlists.get(id);
    if (!p || p.userId !== userId) return null;
    p.name = name;
    p.updatedAt = new Date();
    return this.findPlaylist(id, userId);
  }

  deletePlaylist(id: string, userId: string): boolean {
    const p = this.playlists.get(id);
    if (!p || p.userId !== userId) return false;
    this.playlists.delete(id);
    for (const [tid, t] of this.tracks) {
      if (t.playlistId === id) this.tracks.delete(tid);
    }
    return true;
  }

  listTracks(playlistId: string): PlaylistTrack[] {
    return [...this.tracks.values()]
      .filter(t => t.playlistId === playlistId)
      .sort((a, b) => a.position - b.position)
      .map(t => ({
        id: t.id,
        playlistId: t.playlistId,
        videoId: t.videoId,
        title: t.title,
        channelName: t.channelName,
        thumbnailUrl: t.thumbnailUrl,
        durationSeconds: t.durationSeconds,
        position: t.position,
        addedAt: t.addedAt.toISOString(),
      }));
  }

  addTrack(playlistId: string, track: NewTrack): PlaylistTrack {
    const positions = [...this.tracks.values()]
      .filter(t => t.playlistId === playlistId)
      .map(t => t.position);
    const position = positions.length > 0 ? Math.max(...positions) + 1 : 0;
    const t: MemTrack = { id: this.nextId(), playlistId, position, addedAt: new Date(), ...track };
    this.tracks.set(t.id, t);
    return {
      id: t.id,
      playlistId: t.playlistId,
      videoId: t.videoId,
      title: t.title,
      channelName: t.channelName,
      thumbnailUrl: t.thumbnailUrl,
      durationSeconds: t.durationSeconds,
      position: t.position,
      addedAt: t.addedAt.toISOString(),
    };
  }

  removeTrack(playlistId: string, trackId: string): boolean {
    const t = this.tracks.get(trackId);
    if (!t || t.playlistId !== playlistId) return false;
    this.tracks.delete(trackId);
    return true;
  }

  reorderTracks(playlistId: string, trackIds: string[]): void {
    for (let i = 0; i < trackIds.length; i++) {
      const t = this.tracks.get(trackIds[i]!);
      if (t && t.playlistId === playlistId) t.position = i;
    }
  }
}

const memStore = new InMemoryPlaylistStore();

let dbOfflineUntil = 0;
function isDbAvailable(): boolean {
  return Date.now() > dbOfflineUntil;
}
function markDbFailed(): void {
  dbOfflineUntil = Date.now() + 15_000;
}

// ── Playlist CRUD ─────────────────────────────────────────────────────────────

export async function listPlaylistsByUser(userId: string): Promise<Playlist[]> {
  if (!isDbAvailable()) {
    return memStore.listPlaylists(userId);
  }
  try {
    const rows = await db
      .select({
        id:         schema.playlists.id,
        name:       schema.playlists.name,
        position:   schema.playlists.position,
        createdAt:  schema.playlists.createdAt,
        updatedAt:  schema.playlists.updatedAt,
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

    return rows.map(dbRowToPlaylist);
  } catch {
    markDbFailed();
    return memStore.listPlaylists(userId);
  }
}

export async function findPlaylistById(
  playlistId: string,
  userId: string
): Promise<Playlist | null> {
  if (!isDbAvailable()) {
    return memStore.findPlaylist(playlistId, userId);
  }
  try {
    const [pl] = await db
      .select({
        id:        schema.playlists.id,
        name:      schema.playlists.name,
        position:  schema.playlists.position,
        createdAt: schema.playlists.createdAt,
        updatedAt: schema.playlists.updatedAt,
      })
      .from(schema.playlists)
      .where(
        and(
          eq(schema.playlists.id, playlistId),
          eq(schema.playlists.userId, userId)
        )
      )
      .limit(1);

    if (!pl) return null;

    const [tc] = await db
      .select({ trackCount: count(schema.playlistTracks.id) })
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, playlistId));

    return {
      id:         pl.id,
      name:       pl.name,
      position:   pl.position,
      trackCount: Number(tc?.trackCount ?? 0),
      createdAt:  pl.createdAt.toISOString(),
      updatedAt:  pl.updatedAt.toISOString(),
    };
  } catch {
    markDbFailed();
    return memStore.findPlaylist(playlistId, userId);
  }
}

export async function createPlaylist(
  userId: string,
  name: string
): Promise<Playlist> {
  if (!isDbAvailable()) {
    return memStore.createPlaylist(userId, name);
  }
  try {
    const [{ maxPosition }] = await db
      .select({
        maxPosition: sql<number>`COALESCE(MAX(${schema.playlists.position}), -1)`,
      })
      .from(schema.playlists)
      .where(eq(schema.playlists.userId, userId));

    const position = (maxPosition ?? -1) + 1;

    const [row] = await db
      .insert(schema.playlists)
      .values({ userId, name, position })
      .returning();

    return {
      id:         row.id,
      name:       row.name,
      position:   row.position,
      trackCount: 0,
      createdAt:  row.createdAt.toISOString(),
      updatedAt:  row.updatedAt.toISOString(),
    };
  } catch {
    markDbFailed();
    return memStore.createPlaylist(userId, name);
  }
}

export async function updatePlaylistName(
  playlistId: string,
  userId: string,
  name: string
): Promise<Playlist | null> {
  if (!isDbAvailable()) {
    return memStore.renamePlaylist(playlistId, userId, name);
  }
  try {
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
    return findPlaylistById(playlistId, userId);
  } catch {
    markDbFailed();
    return memStore.renamePlaylist(playlistId, userId, name);
  }
}

export async function deletePlaylist(
  playlistId: string,
  userId: string
): Promise<boolean> {
  if (!isDbAvailable()) {
    return memStore.deletePlaylist(playlistId, userId);
  }
  try {
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
  } catch {
    markDbFailed();
    return memStore.deletePlaylist(playlistId, userId);
  }
}

// ── Tracks ────────────────────────────────────────────────────────────────────

export async function listTracksByPlaylist(
  playlistId: string
): Promise<PlaylistTrack[]> {
  if (!isDbAvailable()) {
    return memStore.listTracks(playlistId);
  }
  try {
    const rows = await db
      .select()
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, playlistId))
      .orderBy(asc(schema.playlistTracks.position));

    return rows.map(dbRowToTrack);
  } catch {
    markDbFailed();
    return memStore.listTracks(playlistId);
  }
}

export async function addTrack(
  playlistId: string,
  track: NewTrack
): Promise<PlaylistTrack> {
  if (!isDbAvailable()) {
    return memStore.addTrack(playlistId, track);
  }
  try {
    const [{ maxPosition }] = await db
      .select({
        maxPosition: sql<number>`COALESCE(MAX(${schema.playlistTracks.position}), -1)`,
      })
      .from(schema.playlistTracks)
      .where(eq(schema.playlistTracks.playlistId, playlistId));

    const position = (maxPosition ?? -1) + 1;

    const [row] = await db
      .insert(schema.playlistTracks)
      .values({ playlistId, position, ...track })
      .returning();

    await db
      .update(schema.playlists)
      .set({ updatedAt: new Date() })
      .where(eq(schema.playlists.id, playlistId));

    return dbRowToTrack(row);
  } catch {
    markDbFailed();
    return memStore.addTrack(playlistId, track);
  }
}

export async function removeTrack(
  playlistId: string,
  trackId: string
): Promise<boolean> {
  if (!isDbAvailable()) {
    return memStore.removeTrack(playlistId, trackId);
  }
  try {
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
  } catch {
    markDbFailed();
    return memStore.removeTrack(playlistId, trackId);
  }
}

export async function reorderTracks(
  playlistId: string,
  trackIds: string[]
): Promise<void> {
  if (!isDbAvailable()) {
    memStore.reorderTracks(playlistId, trackIds);
    return;
  }
  try {
    await db.transaction(async (tx) => {
      for (let i = 0; i < trackIds.length; i++) {
        await tx
          .update(schema.playlistTracks)
          .set({ position: i })
          .where(
            and(
              eq(schema.playlistTracks.id, trackIds[i]!),
              eq(schema.playlistTracks.playlistId, playlistId)
            )
          );
      }
      await tx
        .update(schema.playlists)
        .set({ updatedAt: new Date() })
        .where(eq(schema.playlists.id, playlistId));
    });
  } catch {
    markDbFailed();
    memStore.reorderTracks(playlistId, trackIds);
  }
}

// ── Mappers ───────────────────────────────────────────────────────────────────

function dbRowToPlaylist(row: {
  id: string;
  name: string;
  position: number;
  trackCount: unknown;
  createdAt: Date;
  updatedAt: Date;
}): Playlist {
  return {
    id:         row.id,
    name:       row.name,
    position:   row.position,
    trackCount: Number(row.trackCount),
    createdAt:  row.createdAt.toISOString(),
    updatedAt:  row.updatedAt.toISOString(),
  };
}

function dbRowToTrack(row: {
  id: string;
  playlistId: string;
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number;
  position: number;
  addedAt: Date;
}): PlaylistTrack {
  return {
    id:              row.id,
    playlistId:      row.playlistId,
    videoId:         row.videoId,
    title:           row.title,
    channelName:     row.channelName,
    thumbnailUrl:    row.thumbnailUrl,
    durationSeconds: row.durationSeconds,
    position:        row.position,
    addedAt:         row.addedAt.toISOString(),
  };
}
