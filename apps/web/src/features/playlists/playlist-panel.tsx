"use client";

// ============================================
// DENGARKAN — Playlist Panel
//
// Full-featured interactive playlist manager:
//   • Optimistic CRUD (create, rename, delete, add, remove, reorder)
//   • Touch-friendly mobile Drag & Drop (Pointer Events, 44px handle, touch-action: none)
//   • Full Accessibility (Move Up / Down buttons, Keyboard ArrowUp/Down, aria-live)
//   • Zero-frame-drop visual feedback during drag
// ============================================

import React, { useState, useRef, useCallback } from "react";
import type { Playlist, PlaylistTrack } from "@dengarkan/shared";
import { usePlaylistContext } from "./context";
import { usePlayer } from "@/features/player/context";
import { parseTrackMeta } from "@/lib/track-meta";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function IconMusic({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    </svg>
  );
}
function IconPlus({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconTrash({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" />
    </svg>
  );
}
function IconPencil({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}
function IconChevronLeft({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
function IconChevronUp({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}
function IconChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function IconGrip({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="5" r="1" /><circle cx="15" cy="5" r="1" />
      <circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="19" r="1" /><circle cx="15" cy="19" r="1" />
    </svg>
  );
}

// ── Create Playlist Form ──────────────────────────────────────────────────────

function CreatePlaylistForm({ onDone }: { onDone: () => void }) {
  const { createPlaylist } = usePlaylistContext();
  const [name,   setName]   = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsBusy(true);
    try {
      await createPlaylist(trimmed);
      onDone();
    } catch {
      // toast shown in hook
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 p-3 rounded-2xl bg-surface-2 border border-white/8 mb-3">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Playlist name…"
        maxLength={200}
        className="flex-1 min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
      />
      <button
        type="submit"
        disabled={isBusy || !name.trim()}
        className="text-xs font-semibold px-3 py-1.5 rounded-xl bg-brand-500 text-white disabled:opacity-50 transition-default hover:bg-brand-400"
      >
        {isBusy ? "…" : "Create"}
      </button>
      <button type="button" onClick={onDone} className="text-xs text-text-muted hover:text-text-primary transition-default px-1">
        ✕
      </button>
    </form>
  );
}

// ── Rename Inline ─────────────────────────────────────────────────────────────

function RenameInline({
  playlist,
  onDone,
}: {
  playlist: Playlist;
  onDone: () => void;
}) {
  const { renamePlaylist } = usePlaylistContext();
  const [name,   setName]   = useState(playlist.name);
  const [isBusy, setIsBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === playlist.name) { onDone(); return; }
    setIsBusy(true);
    try {
      await renamePlaylist(playlist.id, trimmed);
    } catch {
      // rollback and toast handled in hook
    } finally {
      setIsBusy(false);
      onDone();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex-1 flex gap-1.5 min-w-0">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={handleSubmit}
        className="flex-1 min-w-0 text-sm text-text-primary bg-surface-3 rounded-lg px-2 py-0.5 focus:outline-none border border-brand-500/40"
      />
      <button type="submit" disabled={isBusy} className="text-xs text-brand-400 px-1.5">
        {isBusy ? "…" : "✓"}
      </button>
    </form>
  );
}

// ── Playlist List ─────────────────────────────────────────────────────────────

function PlaylistList() {
  const {
    playlists,
    isLoading,
    activePlaylist,
    openPlaylist,
    deletePlaylist,
  } = usePlaylistContext();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-2 px-1">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 rounded-2xl bg-surface-1/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {/* Create button */}
      <button
        onClick={() => setShowCreate(true)}
        className="flex items-center gap-2 w-full px-3 py-2.5 rounded-2xl text-sm text-text-muted hover:text-brand-300 hover:bg-surface-2 border border-dashed border-white/10 hover:border-brand-500/30 transition-default mb-1"
      >
        <IconPlus className="w-4 h-4" />
        New playlist
      </button>

      {showCreate && (
        <CreatePlaylistForm onDone={() => setShowCreate(false)} />
      )}

      {playlists.length === 0 && !showCreate && (
        <div className="text-center py-10 text-text-muted">
          <IconMusic className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No playlists yet</p>
          <p className="text-xs mt-1 opacity-60">Create one to save your music</p>
        </div>
      )}

      {playlists.map((pl) => {
        const isActive   = activePlaylist?.id === pl.id;
        const isDeleting = deletingId === pl.id;

        return (
          <div
            key={pl.id}
            className={`group flex items-center gap-2 px-3 py-2.5 rounded-2xl border transition-default ${
              isActive
                ? "bg-brand-500/10 border-brand-500/25"
                : "bg-surface-1/30 hover:bg-surface-2/50 border-white/5"
            }`}
          >
            {/* Playlist icon */}
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${isActive ? "bg-brand-500/20 text-brand-400" : "bg-surface-3 text-text-muted"}`}>
              <IconMusic className="w-4 h-4" />
            </div>

            {/* Name / rename */}
            {renamingId === pl.id ? (
              <RenameInline playlist={pl} onDone={() => setRenamingId(null)} />
            ) : (
              <button
                onClick={() => openPlaylist(pl)}
                className="flex-1 min-w-0 text-left"
              >
                <p className={`text-sm font-medium truncate ${isActive ? "text-brand-300" : "text-text-primary"}`}>
                  {pl.name}
                </p>
                <p className="text-xs text-text-muted">
                  {pl.trackCount} {pl.trackCount === 1 ? "track" : "tracks"}
                </p>
              </button>
            )}

            {/* Actions */}
            {renamingId !== pl.id && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-default">
                <button
                  onClick={() => setRenamingId(pl.id)}
                  className="p-1.5 rounded-lg hover:bg-surface-3 text-text-muted hover:text-text-primary transition-default"
                  aria-label="Rename playlist"
                >
                  <IconPencil className="w-3.5 h-3.5" />
                </button>
                <button
                  disabled={isDeleting}
                  onClick={async () => {
                    setDeletingId(pl.id);
                    try { await deletePlaylist(pl.id); }
                    catch { /* rollback handled in hook */ }
                    finally { setDeletingId(null); }
                  }}
                  className="p-1.5 rounded-lg hover:bg-error/10 text-text-muted hover:text-error transition-default disabled:opacity-40"
                  aria-label="Delete playlist"
                >
                  {isDeleting
                    ? <span className="text-xs">…</span>
                    : <IconTrash className="w-3.5 h-3.5" />
                  }
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Track Row (Touch-Friendly Drag & Accessible Controls) ──────────────────────

interface TrackRowProps {
  track: PlaylistTrack;
  index: number;
  allTracks: PlaylistTrack[];
  isDragging: boolean;
  isDropTarget: boolean;
  onStartDrag: (index: number) => void;
  onMoveDrag: (clientY: number) => void;
  onEndDrag: () => void;
  onCancelDrag: () => void;
  onAnnounce: (msg: string) => void;
}

function TrackRow({
  track,
  index,
  allTracks,
  isDragging,
  isDropTarget,
  onStartDrag,
  onMoveDrag,
  onEndDrag,
  onCancelDrag,
  onAnnounce,
}: TrackRowProps) {
  const { removeTrack, moveTrackUp, moveTrackDown } = usePlaylistContext();
  const {
    currentTrack,
    isPlaying,
    playPlaylist,
    toggle,
    playTrackAtIndex,
    allTracks: playerAllTracks,
  } = usePlayer();
  const [isRemoving, setIsRemoving] = useState(false);

  const isCurrent = currentTrack?.videoId === track.videoId;

  const currentPlaylistTrackIdx = allTracks.findIndex(
    (t) => t.videoId === currentTrack?.videoId
  );
  const isPlayed = currentPlaylistTrackIdx !== -1 && index < currentPlaylistTrackIdx;

  const meta = parseTrackMeta(track.title, track.channelName, track.durationSeconds);

  const handlePlay = () => {
    if (isCurrent) {
      toggle();
      return;
    }

    const isSameSession =
      playerAllTracks.length === allTracks.length &&
      playerAllTracks.every((t, i) => t.videoId === allTracks[i]?.videoId);

    if (isSameSession) {
      void playTrackAtIndex(index);
    } else {
      void playPlaylist(
        allTracks.map((t) => ({
          videoId:         t.videoId,
          title:           t.title,
          channelName:     t.channelName,
          thumbnailUrl:    t.thumbnailUrl,
          durationSeconds: t.durationSeconds,
        })),
        index
      );
    }
  };

  return (
    <div
      data-track-index={index}
      className={`group relative flex items-center gap-2.5 px-2.5 py-2 rounded-xl border transition-all duration-150 ${
        isDragging
          ? "opacity-75 scale-[1.02] shadow-xl border-brand-400/60 bg-surface-3 ring-2 ring-brand-500/30 z-20"
          : isDropTarget
          ? "border-t-2 border-brand-400 bg-brand-500/5"
          : isCurrent
          ? "bg-brand-500/10 border-brand-500/25 shadow-md shadow-brand-500/5"
          : isPlayed
          ? "hover:bg-surface-2/40 border-transparent hover:border-white/5 opacity-80 hover:opacity-100"
          : "hover:bg-surface-2/50 border-transparent hover:border-white/5"
      }`}
    >
      {/* Touch-Friendly Drag Handle (44x44px hit target, touch-action: none for iOS) */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Reorder ${track.title}. Position ${index + 1} of ${allTracks.length}. Use Arrow Up/Down to move.`}
        className="w-11 h-11 -ml-2 flex items-center justify-center text-text-muted opacity-40 hover:opacity-100 hover:text-brand-300 active:opacity-100 cursor-grab active:cursor-grabbing select-none flex-shrink-0 touch-none"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          onStartDrag(index);
        }}
        onPointerMove={(e) => {
          if (isDragging) {
            onMoveDrag(e.clientY);
          }
        }}
        onPointerUp={(e) => {
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
          onEndDrag();
        }}
        onPointerCancel={(e) => {
          try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
          onCancelDrag();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            if (index > 0) {
              onAnnounce(`Moved ${track.title} up to position ${index} of ${allTracks.length}`);
              void moveTrackUp(index);
            }
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (index < allTracks.length - 1) {
              onAnnounce(`Moved ${track.title} down to position ${index + 2} of ${allTracks.length}`);
              void moveTrackDown(index);
            }
          }
        }}
      >
        <IconGrip className="w-4 h-4" />
      </div>

      {/* Accessible Move Up / Down controls */}
      <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-default flex-shrink-0">
        <button
          disabled={index === 0}
          onClick={(e) => {
            e.stopPropagation();
            onAnnounce(`Moved ${track.title} up to position ${index} of ${allTracks.length}`);
            void moveTrackUp(index);
          }}
          className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary disabled:opacity-20 transition-default cursor-pointer"
          aria-label={`Move ${track.title} up`}
          title="Move up"
        >
          <IconChevronUp className="w-3 h-3" />
        </button>
        <button
          disabled={index === allTracks.length - 1}
          onClick={(e) => {
            e.stopPropagation();
            onAnnounce(`Moved ${track.title} down to position ${index + 2} of ${allTracks.length}`);
            void moveTrackDown(index);
          }}
          className="p-1 rounded hover:bg-surface-3 text-text-muted hover:text-text-primary disabled:opacity-20 transition-default cursor-pointer"
          aria-label={`Move ${track.title} down`}
          title="Move down"
        >
          <IconChevronDown className="w-3 h-3" />
        </button>
      </div>

      {/* Number or Equalizer */}
      <div className="w-6 flex items-center justify-center flex-shrink-0">
        {isCurrent && isPlaying ? (
          <div className="w-3.5 h-3.5 flex items-end gap-0.5">
            <span className="w-0.5 h-3 bg-brand-400 animate-pulse" />
            <span className="w-0.5 h-1.5 bg-brand-400 animate-pulse delay-75" />
            <span className="w-0.5 h-3 bg-brand-400 animate-pulse delay-150" />
          </div>
        ) : (
          <span
            className={`text-xs tabular-nums font-semibold ${
              isCurrent
                ? "text-brand-400"
                : isPlayed
                ? "text-text-muted/60"
                : "text-text-muted"
            }`}
          >
            {(index + 1).toString().padStart(2, "0")}
          </span>
        )}
      </div>

      {/* Position / thumbnail */}
      <button
        type="button"
        onClick={handlePlay}
        className="relative w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 bg-surface-3 focus:outline-none cursor-pointer"
        aria-label={`${isCurrent && isPlaying ? "Pause" : "Play"} ${track.title}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={track.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        {isCurrent ? (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            {isPlaying ? (
              <svg className="w-4 h-4 text-brand-400 fill-current" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-brand-400 ml-0.5 fill-current" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-default">
            <svg className="w-4 h-4 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </div>
        )}
      </button>

      {/* Track info — Clickable to play */}
      <button
        type="button"
        onClick={handlePlay}
        className="flex-1 min-w-0 text-left cursor-pointer focus:outline-none"
        aria-label={`${isCurrent && isPlaying ? "Pause" : "Play"} ${track.title}`}
      >
        <div className="flex items-center gap-1.5">
          {isCurrent && (
            <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-brand-400 text-black flex-shrink-0">
              Diputar
            </span>
          )}
          <p className={`text-xs font-semibold truncate ${isCurrent ? "text-brand-400" : isPlayed ? "text-white/70" : "text-white"}`}>
            {meta.title}
          </p>
        </div>
        <p className={`text-[11px] font-medium truncate mt-0.5 ${isCurrent ? "text-white/90" : isPlayed ? "text-white/50" : "text-white/80"}`}>
          {meta.artist}
        </p>
        <p className="text-[10px] text-text-muted truncate mt-0.5">
          {meta.channelInfo}
        </p>
      </button>

      {/* Remove */}
      <button
        disabled={isRemoving}
        onClick={async () => {
          setIsRemoving(true);
          try { await removeTrack(track.id); }
          catch { /* rollback handled in hook */ }
          finally { setIsRemoving(false); }
        }}
        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-error/10 text-text-muted hover:text-error transition-default disabled:opacity-40 flex-shrink-0"
        aria-label="Remove track"
      >
        {isRemoving ? <span className="text-xs">…</span> : <IconTrash className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

// ── Playlist Detail (track list view with drag & drop) ─────────────────────────

function PlaylistDetail() {
  const {
    activePlaylist,
    activeTracks,
    isTracksLoading,
    closePlaylist,
    reorderTracks,
  } = usePlaylistContext();
  const { playPlaylist } = usePlayer();

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex,     setDropIndex]     = useState<number | null>(null);
  const [announcement,  setAnnouncement]  = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleStartDrag = useCallback((index: number) => {
    setDraggingIndex(index);
    setDropIndex(index);
  }, []);

  const handleMoveDrag = useCallback((clientY: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll("[data-track-index]")) as HTMLElement[];
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i]!.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        setDropIndex(i);
        return;
      }
    }
    if (rows.length > 0) setDropIndex(rows.length - 1);
  }, []);

  const handleEndDrag = useCallback(() => {
    if (
      draggingIndex !== null &&
      dropIndex !== null &&
      draggingIndex !== dropIndex
    ) {
      const newTracks = [...activeTracks];
      const [moved] = newTracks.splice(draggingIndex, 1);
      if (moved) {
        newTracks.splice(dropIndex, 0, moved);
        setAnnouncement(`Moved ${moved.title} to position ${dropIndex + 1} of ${newTracks.length}`);
        void reorderTracks(newTracks.map((t) => t.id));
      }
    }
    setDraggingIndex(null);
    setDropIndex(null);
  }, [draggingIndex, dropIndex, activeTracks, reorderTracks]);

  const handleCancelDrag = useCallback(() => {
    setDraggingIndex(null);
    setDropIndex(null);
  }, []);

  const playAll = () => {
    if (activeTracks.length === 0) return;
    void playPlaylist(
      activeTracks.map((t) => ({
        videoId:         t.videoId,
        title:           t.title,
        channelName:     t.channelName,
        thumbnailUrl:    t.thumbnailUrl,
        durationSeconds: t.durationSeconds,
      })),
      0
    );
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Screen reader live region for reorder announcements */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {/* Back + title */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={closePlaylist}
          className="p-1.5 rounded-xl hover:bg-surface-2 text-text-muted hover:text-text-primary transition-default flex-shrink-0"
          aria-label="Back to playlists"
        >
          <IconChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-text-primary truncate">{activePlaylist?.name}</h2>
          <p className="text-xs text-text-muted">{activeTracks.length} tracks</p>
        </div>
        {activeTracks.length > 0 && (
          <button
            onClick={playAll}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl bg-brand-500 hover:bg-brand-400 text-white transition-default flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            Play all
          </button>
        )}
      </div>

      {/* Tracks list */}
      {isTracksLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 rounded-xl bg-surface-1/40 animate-pulse" />
          ))}
        </div>
      ) : activeTracks.length === 0 ? (
        <div className="text-center py-10 text-text-muted">
          <IconMusic className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">No tracks yet</p>
          <p className="text-xs mt-1 opacity-60">Search for music and add it here</p>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="flex flex-col gap-0.5 overflow-y-auto flex-1 scrollbar-thin"
        >
          {activeTracks.map((track, i) => (
            <TrackRow
              key={track.id}
              track={track}
              index={i}
              allTracks={activeTracks}
              isDragging={draggingIndex === i}
              isDropTarget={dropIndex === i && draggingIndex !== i}
              onStartDrag={handleStartDrag}
              onMoveDrag={handleMoveDrag}
              onEndDrag={handleEndDrag}
              onCancelDrag={handleCancelDrag}
              onAnnounce={setAnnouncement}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function PlaylistPanel() {
  const { activePlaylist } = usePlaylistContext();

  return (
    <div className="flex flex-col h-full">
      {!activePlaylist && (
        <div className="flex items-center gap-2 mb-4">
          <IconMusic className="w-4 h-4 text-brand-400" />
          <h2 className="text-sm font-semibold text-text-primary">Playlists</h2>
        </div>
      )}

      {activePlaylist ? <PlaylistDetail /> : <PlaylistList />}
    </div>
  );
}
