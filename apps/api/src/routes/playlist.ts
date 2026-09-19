// ============================================
// DENGARKAN — Playlist Routes
// ============================================

import type { FastifyPluginAsync } from 'fastify';
import {
  createPlaylistSchema,
  renamePlaylistSchema,
  addTrackSchema,
  reorderTracksSchema,
} from '@dengarkan/shared';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUserPlaylists,
  getPlaylistById,
  getPlaylistTracks,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylistTracks,
} from '../services/playlist.js';

export const playlistRoutes: FastifyPluginAsync = async (app) => {
  // All playlist routes require authentication
  app.addHook('preHandler', authMiddleware);

  // GET /api/playlists — List user's playlists
  app.get('/api/playlists', async (request, reply) => {
    const playlists = await getUserPlaylists(request.userId!);
    return { playlists };
  });

  // POST /api/playlists — Create playlist
  app.post('/api/playlists', async (request, reply) => {
    const parsed = createPlaylistSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: parsed.error.issues[0]?.message || 'Invalid playlist name',
        statusCode: 400,
      });
    }

    const playlist = await createPlaylist(request.userId!, parsed.data.name);
    return reply.status(201).send(playlist);
  });

  // GET /api/playlists/:id — Get playlist with tracks
  app.get<{ Params: { id: string } }>(
    '/api/playlists/:id',
    async (request, reply) => {
      const playlist = await getPlaylistById(
        request.params.id,
        request.userId!
      );

      if (!playlist) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Playlist not found',
          statusCode: 404,
        });
      }

      const tracks = await getPlaylistTracks(playlist.id);

      return {
        id: playlist.id,
        name: playlist.name,
        position: playlist.position,
        trackCount: tracks.length,
        createdAt: playlist.createdAt.toISOString(),
        updatedAt: playlist.updatedAt.toISOString(),
        tracks,
      };
    }
  );

  // PATCH /api/playlists/:id — Rename playlist
  app.patch<{ Params: { id: string } }>(
    '/api/playlists/:id',
    async (request, reply) => {
      const parsed = renamePlaylistSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message || 'Invalid playlist name',
          statusCode: 400,
        });
      }

      const updated = await renamePlaylist(
        request.params.id,
        request.userId!,
        parsed.data.name
      );

      if (!updated) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Playlist not found',
          statusCode: 404,
        });
      }

      return updated;
    }
  );

  // DELETE /api/playlists/:id — Delete playlist
  app.delete<{ Params: { id: string } }>(
    '/api/playlists/:id',
    async (request, reply) => {
      const deleted = await deletePlaylist(
        request.params.id,
        request.userId!
      );

      if (!deleted) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Playlist not found',
          statusCode: 404,
        });
      }

      return { message: 'Playlist deleted' };
    }
  );

  // POST /api/playlists/:id/tracks — Add track to playlist
  app.post<{ Params: { id: string } }>(
    '/api/playlists/:id/tracks',
    async (request, reply) => {
      const parsed = addTrackSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: parsed.error.issues[0]?.message || 'Invalid track data',
          statusCode: 400,
        });
      }

      // Verify playlist ownership
      const playlist = await getPlaylistById(
        request.params.id,
        request.userId!
      );
      if (!playlist) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Playlist not found',
          statusCode: 404,
        });
      }

      const track = await addTrackToPlaylist(playlist.id, parsed.data);
      return reply.status(201).send(track);
    }
  );

  // DELETE /api/playlists/:id/tracks/:trackId — Remove track
  app.delete<{ Params: { id: string; trackId: string } }>(
    '/api/playlists/:id/tracks/:trackId',
    async (request, reply) => {
      // Verify playlist ownership
      const playlist = await getPlaylistById(
        request.params.id,
        request.userId!
      );
      if (!playlist) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Playlist not found',
          statusCode: 404,
        });
      }

      const removed = await removeTrackFromPlaylist(
        playlist.id,
        request.params.trackId
      );

      if (!removed) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Track not found',
          statusCode: 404,
        });
      }

      return { message: 'Track removed' };
    }
  );

  // PATCH /api/playlists/:id/reorder — Reorder tracks
  app.patch<{ Params: { id: string } }>(
    '/api/playlists/:id/reorder',
    async (request, reply) => {
      const parsed = reorderTracksSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Bad Request',
          message:
            parsed.error.issues[0]?.message || 'Invalid track order data',
          statusCode: 400,
        });
      }

      // Verify playlist ownership
      const playlist = await getPlaylistById(
        request.params.id,
        request.userId!
      );
      if (!playlist) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Playlist not found',
          statusCode: 404,
        });
      }

      await reorderPlaylistTracks(playlist.id, parsed.data.trackIds);
      return { message: 'Tracks reordered' };
    }
  );
};
