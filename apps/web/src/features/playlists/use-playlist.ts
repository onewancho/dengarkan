"use client";

// ============================================
// DENGARKAN — Playlist Feature: Hook
//
// Manages all playlist state with:
//   • Full Optimistic UI pattern (beforeState → optimisticState → serverRequest → success / rollback)
//   • Rollback on failure with toast notification
//   • Race condition mitigation (monotonic sequence counters, debounced reorders)
//   • Accessible reordering helpers (moveTrackUp, moveTrackDown)
// ============================================

import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import type { Playlist, PlaylistTrack, SearchResult } from "@dengarkan/shared";
import { apiClient } from "@/services/api-client";
import { useToast } from "@/features/ui/toast";

export interface PlaylistState {
  playlists:       Playlist[];
  activeTracks:    PlaylistTrack[];       // tracks of the open playlist
  activePlaylist:  Playlist | null;
  isLoading:       boolean;
  isTracksLoading: boolean;
  error:           string | null;
}

export interface PlaylistActions {
  reload:             () => Promise<void>;
  openPlaylist:       (playlist: Playlist) => Promise<void>;
  closePlaylist:      () => void;
  createPlaylist:     (name: string) => Promise<Playlist>;
  renamePlaylist:     (id: string, name: string) => Promise<void>;
  deletePlaylist:     (id: string) => Promise<void>;
  addTrackToActive:   (track: SearchResult) => Promise<void>;
  addTrackToPlaylist: (playlistId: string, track: SearchResult) => Promise<void>;
  removeTrack:        (trackId: string) => Promise<void>;
  reorderTracks:      (trackIds: string[]) => Promise<void>;
  moveTrackUp:        (index: number) => Promise<void>;
  moveTrackDown:      (index: number) => Promise<void>;
}

export function usePlaylist(): PlaylistState & PlaylistActions {
  const { showToast } = useToast();

  const [playlists,       setPlaylists]       = useState<Playlist[]>([]);
  const [activeTracks,    setActiveTracks]    = useState<PlaylistTrack[]>([]);
  const [activePlaylist,  setActivePlaylist]  = useState<Playlist | null>(null);
  const [isLoading,       setIsLoading]       = useState(true);
  const [isTracksLoading, setIsTracksLoading] = useState(false);
  const [error,           setError]           = useState<string | null>(null);

  // Stable refs for reading latest state inside async callbacks
  const activePlaylistRef = useRef<Playlist | null>(null);
  const activeTracksRef   = useRef<PlaylistTrack[]>([]);
  const playlistsRef      = useRef<Playlist[]>([]);

  useEffect(() => { activePlaylistRef.current = activePlaylist; }, [activePlaylist]);
  useEffect(() => { activeTracksRef.current   = activeTracks;   }, [activeTracks]);
  useEffect(() => { playlistsRef.current      = playlists;      }, [playlists]);

  // Race condition guards
  const fetchTracksSeqRef = useRef(0);
  const reorderSeqRef     = useRef(0);
  const reorderTimerRef   = useRef<NodeJS.Timeout | null>(null);
  const beforeReorderRef  = useRef<PlaylistTrack[]>([]);

  // ── Load all playlists ────────────────────────────────────────────────────

  const reload = useCallback(async () => {
    try {
      const { playlists: data } = await apiClient.playlists.list();
      setPlaylists(data);
      setError(null);
    } catch {
      setError("Failed to load playlists");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function fetchInitialPlaylists() {
      try {
        const { playlists: data } = await apiClient.playlists.list();
        if (!cancelled) {
          setPlaylists(data);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setError("Failed to load playlists");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void fetchInitialPlaylists();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Playlist Open / Close ─────────────────────────────────────────────────

  const openPlaylist = useCallback(async (playlist: Playlist) => {
    const seq = ++fetchTracksSeqRef.current;
    setActivePlaylist(playlist);
    setIsTracksLoading(true);
    try {
      const detail = await apiClient.playlists.get(playlist.id);
      // Ignore if user opened another playlist while this was in flight
      if (seq === fetchTracksSeqRef.current) {
        setActiveTracks(detail.tracks);
      }
    } catch {
      if (seq === fetchTracksSeqRef.current) {
        setActiveTracks([]);
        showToast("Failed to load playlist tracks", "error");
      }
    } finally {
      if (seq === fetchTracksSeqRef.current) {
        setIsTracksLoading(false);
      }
    }
  }, [showToast]);

  const closePlaylist = useCallback(() => {
    fetchTracksSeqRef.current++; // cancel any in-flight load
    setActivePlaylist(null);
    setActiveTracks([]);
  }, []);

  // ── Playlist CRUD (Optimistic) ────────────────────────────────────────────

  const createPlaylist = useCallback(async (name: string): Promise<Playlist> => {
    try {
      const created = await apiClient.playlists.create(name);
      setPlaylists((prev) => [...prev, created]);
      showToast(`Playlist "${created.name}" created`, "success");
      return created;
    } catch (err) {
      showToast("Failed to create playlist", "error");
      throw err;
    }
  }, [showToast]);

  const renamePlaylist = useCallback(async (id: string, name: string) => {
    // 1. beforeState
    const beforePlaylists = playlistsRef.current;
    const beforeActive    = activePlaylistRef.current;

    // 2. optimisticState
    setPlaylists((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name } : p))
    );
    if (activePlaylistRef.current?.id === id) {
      setActivePlaylist((p) => (p ? { ...p, name } : p));
    }

    // 3. serverRequest
    try {
      await apiClient.playlists.rename(id, name);
      // 4. success
      showToast("Playlist renamed", "success");
    } catch (err) {
      // 5. rollback on failure
      setPlaylists(beforePlaylists);
      if (beforeActive?.id === id) {
        setActivePlaylist(beforeActive);
      }
      showToast("Failed to rename playlist. Changes reverted.", "error");
      throw err;
    }
  }, [showToast]);

  const deletePlaylist = useCallback(async (id: string) => {
    // 1. beforeState
    const beforePlaylists = playlistsRef.current;
    const beforeActive    = activePlaylistRef.current;
    const beforeTracks    = activeTracksRef.current;

    // 2. optimisticState
    setPlaylists((prev) => prev.filter((p) => p.id !== id));
    if (activePlaylistRef.current?.id === id) {
      setActivePlaylist(null);
      setActiveTracks([]);
    }

    // 3. serverRequest
    try {
      await apiClient.playlists.delete(id);
      // 4. success
      showToast("Playlist deleted", "info");
    } catch (err) {
      // 5. rollback on failure
      setPlaylists(beforePlaylists);
      if (beforeActive?.id === id) {
        setActivePlaylist(beforeActive);
        setActiveTracks(beforeTracks);
      }
      showToast("Failed to delete playlist. Changes reverted.", "error");
      throw err;
    }
  }, [showToast]);

  // ── Track Management (Optimistic) ─────────────────────────────────────────

  const addTrackToPlaylist = useCallback(async (playlistId: string, track: SearchResult) => {
    // 1. beforeState
    const beforeTracks    = activeTracksRef.current;
    const beforePlaylists = playlistsRef.current;

    // 2. optimisticState: create optimistic track with temporary ID
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const optimisticTrack: PlaylistTrack = {
      id:              tempId,
      playlistId,
      videoId:         track.videoId,
      title:           track.title,
      channelName:     track.channelName,
      thumbnailUrl:    track.thumbnailUrl,
      durationSeconds: track.durationSeconds,
      position:        beforeTracks.length,
      addedAt:         new Date().toISOString(),
    };

    if (activePlaylistRef.current?.id === playlistId) {
      setActiveTracks((prev) => [...prev, optimisticTrack]);
    }
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === playlistId ? { ...p, trackCount: p.trackCount + 1 } : p
      )
    );

    // 3. serverRequest
    try {
      const added = await apiClient.playlists.addTrack(playlistId, {
        videoId:         track.videoId,
        title:           track.title,
        channelName:     track.channelName,
        thumbnailUrl:    track.thumbnailUrl,
        durationSeconds: track.durationSeconds,
      });

      // 4. success: replace optimistic track with real server response
      if (activePlaylistRef.current?.id === playlistId) {
        setActiveTracks((prev) =>
          prev.map((t) => (t.id === tempId ? added : t))
        );
      }
      showToast("Track added to playlist", "success");
    } catch (err) {
      // 5. rollback on failure
      if (activePlaylistRef.current?.id === playlistId) {
        setActiveTracks(beforeTracks);
      }
      setPlaylists(beforePlaylists);
      showToast("Failed to add track. Changes reverted.", "error");
      throw err;
    }
  }, [showToast]);

  const addTrackToActive = useCallback(async (track: SearchResult) => {
    const pl = activePlaylistRef.current;
    if (!pl) throw new Error("No playlist open");
    await addTrackToPlaylist(pl.id, track);
  }, [addTrackToPlaylist]);

  const removeTrack = useCallback(async (trackId: string) => {
    const pl = activePlaylistRef.current;
    if (!pl) return;

    // 1. beforeState
    const beforeTracks    = activeTracksRef.current;
    const beforePlaylists = playlistsRef.current;

    // 2. optimisticState
    setActiveTracks((prev) => prev.filter((t) => t.id !== trackId));
    setPlaylists((prev) =>
      prev.map((p) =>
        p.id === pl.id ? { ...p, trackCount: Math.max(0, p.trackCount - 1) } : p
      )
    );

    // 3. serverRequest
    try {
      await apiClient.playlists.removeTrack(pl.id, trackId);
      // 4. success
      showToast("Track removed from playlist", "info");
    } catch (err) {
      // 5. rollback on failure
      setActiveTracks(beforeTracks);
      setPlaylists(beforePlaylists);
      showToast("Failed to remove track. Changes reverted.", "error");
      throw err;
    }
  }, [showToast]);

  // ── Reorder (Optimistic + Debounced + Race-Guarded) ───────────────────────

  const reorderTracks = useCallback(async (trackIds: string[]) => {
    const pl = activePlaylistRef.current;
    if (!pl) return;

    // Snapshot original state if this is the start of a reorder series
    if (!reorderTimerRef.current) {
      beforeReorderRef.current = activeTracksRef.current;
    }

    // 1. Optimistic State update immediately (0 delay in UI)
    const trackMap = new Map(activeTracksRef.current.map((t) => [t.id, t]));
    const reordered: PlaylistTrack[] = [];
    for (let i = 0; i < trackIds.length; i++) {
      const t = trackMap.get(trackIds[i]!);
      if (t) reordered.push({ ...t, position: i });
    }
    setActiveTracks(reordered);

    // 2. Sequence tracking to mitigate out-of-order race conditions
    const seq = ++reorderSeqRef.current;

    // 3. Debounce the network request (250ms):
    //    Prevents multiple rapid moves/drags from spamming the server
    if (reorderTimerRef.current) {
      clearTimeout(reorderTimerRef.current);
    }

    return new Promise<void>((resolve, reject) => {
      reorderTimerRef.current = setTimeout(async () => {
        reorderTimerRef.current = null;
        try {
          await apiClient.playlists.reorder(pl.id, trackIds);
          if (seq === reorderSeqRef.current) {
            // Updated snapshot for next series
            beforeReorderRef.current = reordered;
          }
          resolve();
        } catch (err) {
          // Only rollback if this is still the latest reorder request
          if (seq === reorderSeqRef.current) {
            setActiveTracks(beforeReorderRef.current);
            showToast("Failed to reorder tracks. Changes reverted.", "error");
          }
          reject(err);
        }
      }, 250);
    });
  }, [showToast]);

  // ── Accessible Reorder Helpers (Move Up / Down) ───────────────────────────

  const moveTrackUp = useCallback(async (index: number) => {
    const tracks = activeTracksRef.current;
    if (index <= 0 || index >= tracks.length) return;
    const newIds = tracks.map((t) => t.id);
    const temp = newIds[index]!;
    newIds[index] = newIds[index - 1]!;
    newIds[index - 1] = temp;
    await reorderTracks(newIds);
  }, [reorderTracks]);

  const moveTrackDown = useCallback(async (index: number) => {
    const tracks = activeTracksRef.current;
    if (index < 0 || index >= tracks.length - 1) return;
    const newIds = tracks.map((t) => t.id);
    const temp = newIds[index]!;
    newIds[index] = newIds[index + 1]!;
    newIds[index + 1] = temp;
    await reorderTracks(newIds);
  }, [reorderTracks]);

  return {
    playlists,
    activeTracks,
    activePlaylist,
    isLoading,
    isTracksLoading,
    error,
    reload,
    openPlaylist,
    closePlaylist,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToActive,
    addTrackToPlaylist,
    removeTrack,
    reorderTracks,
    moveTrackUp,
    moveTrackDown,
  };
}
