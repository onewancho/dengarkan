// ============================================
// DENGARKAN — Playlists Module: Service
//
// Thin service layer — delegates all DB operations to
// playlist.repository. Routes import from here.
// ============================================

export {
  listPlaylistsByUser   as getUserPlaylists,
  findPlaylistById      as getPlaylistById,
  createPlaylist,
  updatePlaylistName    as renamePlaylist,
  deletePlaylist,
  listTracksByPlaylist  as getPlaylistTracks,
  addTrack              as addTrackToPlaylist,
  removeTrack           as removeTrackFromPlaylist,
  reorderTracks         as reorderPlaylistTracks,
  type NewTrack,
} from '../../infrastructure/repositories/playlist.repository.js';
