// ============================================
// DENGARKAN — Shared Types
// ============================================

// --- Audio ---

export interface AudioStream {
  videoId: string;
  streamUrl: string;
  mimeType: string;
  codec: string;
  bitrate: number;
  sampleRate: number;
  durationSeconds: number;
  expiresAt: number;
  title: string;
  channelName: string;
  thumbnailUrl: string;
}

export interface AudioResolver {
  resolve(videoId: string): Promise<AudioStream>;
  refresh(videoId: string): Promise<AudioStream>;
}

// --- Search ---

export interface SearchResult {
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number;
  durationFormatted: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
}

// --- Auth ---

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthResponse {
  user: AuthUser;
}

// --- Playlist ---

export interface Playlist {
  id: string;
  name: string;
  position: number;
  trackCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistTrack {
  id: string;
  playlistId: string;
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number;
  position: number;
  addedAt: string;
}

// --- Queue (client-side only, not persisted) ---

export interface QueueTrack {
  videoId: string;
  title: string;
  channelName: string;
  thumbnailUrl: string;
  durationSeconds: number;
}

// --- Player State ---

export type PlayerState =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'refreshing'
  | 'error';

// --- API Error ---

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
}
