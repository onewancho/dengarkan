// ============================================
// DENGARKAN — API Client Service
// ============================================

import type {
  AuthResponse,
  ApiError,
  SearchResponse,
  AudioStream,
  Playlist,
  PlaylistTrack,
} from "@dengarkan/shared";

const API_BASE = ""; // Proxy via Next.js rewrites → Fastify :3001

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) {
    headers["Content-Type"] = "application/json";
  }
  if (init.headers) {
    Object.assign(headers, init.headers);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    const err: ApiError = await res.json().catch(() => ({
      error: "Error",
      message: res.statusText,
      statusCode: res.status,
    }));
    throw err;
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as unknown as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as unknown as T;
  }
}

// ─── Typed API Namespaces ─────────────────────────────────────────────────────

export const apiClient = {
  auth: {
    login: (username: string, password: string): Promise<AuthResponse> =>
      request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      }),
    logout: (): Promise<void> =>
      request("/api/auth/logout", { method: "POST" }),
    session: (): Promise<AuthResponse> => request("/api/auth/session"),
  },

  youtube: {
    search: (q: string): Promise<SearchResponse> =>
      request(`/api/youtube/search?${new URLSearchParams({ q })}`),
  },

  audio: {
    resolve: (videoId: string): Promise<AudioStream> =>
      request("/api/audio/resolve", {
        method: "POST",
        body: JSON.stringify({ videoId }),
      }),
    refresh: (videoId: string): Promise<AudioStream> =>
      request("/api/audio/refresh", {
        method: "POST",
        body: JSON.stringify({ videoId }),
      }),
    invalidate: (videoId: string): Promise<void> =>
      request("/api/audio/invalidate", {
        method: "POST",
        body: JSON.stringify({ videoId }),
      }),
    skipContinuous: (sessionId: string, nextIndex?: number): Promise<{ success: boolean }> =>
      request("/api/audio/continuous/skip", {
        method: "POST",
        body: JSON.stringify({ sessionId, nextIndex }),
      }),
    updateContinuousQueue: (sessionId: string, tracks: unknown): Promise<{ success: boolean }> =>
      request("/api/audio/continuous/queue", {
        method: "POST",
        body: JSON.stringify({ sessionId, tracks }),
      }),
    setContinuousRepeat: (sessionId: string, repeatMode: string): Promise<{ success: boolean }> =>
      request("/api/audio/continuous/repeat", {
        method: "POST",
        body: JSON.stringify({ sessionId, repeatMode }),
      }),
  },

  playlists: {
    list: (): Promise<{ playlists: Playlist[] }> =>
      request("/api/playlists"),
    create: (name: string): Promise<Playlist> =>
      request("/api/playlists", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    get: (id: string): Promise<Playlist & { tracks: PlaylistTrack[] }> =>
      request(`/api/playlists/${encodeURIComponent(id)}`),
    rename: (id: string, name: string): Promise<Playlist> =>
      request(`/api/playlists/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    delete: (id: string): Promise<void> =>
      request(`/api/playlists/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    addTrack: (
      playlistId: string,
      track: Omit<PlaylistTrack, "id" | "playlistId" | "position" | "addedAt">
    ): Promise<PlaylistTrack> =>
      request(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
        method: "POST",
        body: JSON.stringify(track),
      }),
    removeTrack: (playlistId: string, trackId: string): Promise<void> =>
      request(
        `/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`,
        { method: "DELETE" }
      ),
    reorder: (playlistId: string, trackIds: string[]): Promise<void> =>
      request(`/api/playlists/${encodeURIComponent(playlistId)}/reorder`, {
        method: "PATCH",
        body: JSON.stringify({ trackIds }),
      }),
  },
};
