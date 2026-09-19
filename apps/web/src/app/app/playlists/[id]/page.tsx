"use client";

// ============================================
// DENGARKAN — /app/playlists/[id] Page
//
// Interactive Playlist Tracklist:
//   • Touch-friendly mobile Drag & Drop (Pointer Events, 44px handle, touch-action: none)
//   • Accessible Move Up / Down controls & keyboard ArrowUp/Down
//   • Play all tracks atomically into engine queue
//   • Optimistic remove track with rollback & toast
// ============================================

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { usePlaylistContext } from "@/features/playlists/context";
import { usePlayer } from "@/features/player/context";
import { parseTrackMeta } from "@/lib/track-meta";
import type { PlaylistTrack } from "@dengarkan/shared";

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

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

  // Index of currently playing track within this playlist (if active)
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

    // If this playlist is already loaded in the player engine session, jump directly
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
      className={`group relative flex items-center gap-2.5 px-3 py-2.5 rounded-2xl border transition-all duration-150 ${
        isDragging
          ? "opacity-75 scale-[1.02] shadow-xl border-[#39FF14]/60 bg-[#222226] ring-2 ring-[#39FF14]/30 z-20"
          : isDropTarget
          ? "border-t-2 border-[#39FF14] bg-[#39FF14]/5"
          : isCurrent
          ? "bg-[#39FF14]/10 border-[#39FF14]/30 shadow-md shadow-[#39FF14]/5"
          : isPlayed
          ? "bg-[#121214]/60 hover:bg-[#18181B] border-white/5 opacity-80 hover:opacity-100"
          : "bg-[#121214] hover:bg-[#18181B] border-white/5"
      }`}
    >
      {/* Drag Handle */}
      <div
        role="button"
        tabIndex={0}
        aria-label={`Urutkan ${track.title}. Posisi ${index + 1} dari ${allTracks.length}. Gunakan Panah Atas/Bawah.`}
        className="touch-none select-none p-1.5 rounded-xl text-[#8E8E93] hover:text-white hover:bg-white/5 cursor-grab active:cursor-grabbing transition-default flex-shrink-0 min-w-[32px] min-h-[36px] flex items-center justify-center focus:outline-none focus:ring-1 focus:ring-[#39FF14]"
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
              onAnnounce(`Memindahkan ${track.title} ke posisi ${index} dari ${allTracks.length}`);
              void moveTrackUp(index);
            }
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (index < allTracks.length - 1) {
              onAnnounce(`Memindahkan ${track.title} ke posisi ${index + 2} dari ${allTracks.length}`);
              void moveTrackDown(index);
            }
          }
        }}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="9" cy="5" r="1" /><circle cx="15" cy="5" r="1" />
          <circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" />
          <circle cx="9" cy="19" r="1" /><circle cx="15" cy="19" r="1" />
        </svg>
      </div>

      {/* Accessible Move Up / Down controls */}
      <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-default flex-shrink-0">
        <button
          disabled={index === 0}
          onClick={(e) => {
            e.stopPropagation();
            onAnnounce(`Memindahkan ${track.title} ke atas`);
            void moveTrackUp(index);
          }}
          className="p-1 rounded text-[#8E8E93] hover:text-white disabled:opacity-20 hover:bg-white/5 transition-default focus:opacity-100 cursor-pointer"
          aria-label={`Pindahkan ${track.title} ke atas`}
          title="Ke atas"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
        <button
          disabled={index === allTracks.length - 1}
          onClick={(e) => {
            e.stopPropagation();
            onAnnounce(`Memindahkan ${track.title} ke bawah`);
            void moveTrackDown(index);
          }}
          className="p-1 rounded text-[#8E8E93] hover:text-white disabled:opacity-20 hover:bg-white/5 transition-default focus:opacity-100 cursor-pointer"
          aria-label={`Pindahkan ${track.title} ke bawah`}
          title="Ke bawah"
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {/* Position Number or Equalizer */}
      <div className="w-6 flex items-center justify-center flex-shrink-0">
        {isCurrent && isPlaying ? (
          <div className="w-3.5 h-3.5 flex items-end gap-0.5">
            <span className="w-0.5 h-3 bg-[#39FF14] animate-pulse" />
            <span className="w-0.5 h-1.5 bg-[#39FF14] animate-pulse delay-75" />
            <span className="w-0.5 h-3 bg-[#39FF14] animate-pulse delay-150" />
          </div>
        ) : (
          <span
            className={`text-xs tabular-nums font-semibold ${
              isCurrent
                ? "text-[#39FF14]"
                : isPlayed
                ? "text-[#8E8E93]/60"
                : "text-[#8E8E93]"
            }`}
          >
            {(index + 1).toString().padStart(2, "0")}
          </span>
        )}
      </div>

      {/* Position / Thumbnail */}
      <button
        type="button"
        onClick={handlePlay}
        className="relative w-11 h-11 rounded-xl overflow-hidden flex-shrink-0 bg-[#222226] border border-white/10 focus:outline-none cursor-pointer"
        aria-label={`${isCurrent && isPlaying ? "Jeda" : "Putar"} ${track.title}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={track.thumbnailUrl} alt="" className="w-full h-full object-cover" />
        {isCurrent ? (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
            {isPlaying ? (
              <svg className="w-4 h-4 text-[#39FF14] fill-current" viewBox="0 0 24 24">
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-[#39FF14] ml-0.5 fill-current" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-default">
            <svg className="w-4 h-4 text-[#39FF14] ml-0.5 fill-current" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
      </button>

      {/* Track Info (Judul Lagu, Penyanyi, nama channel - durasi) — Clickable */}
      <button
        type="button"
        onClick={handlePlay}
        className="flex-1 min-w-0 text-left cursor-pointer focus:outline-none"
        aria-label={`${isCurrent && isPlaying ? "Jeda" : "Putar"} ${track.title}`}
      >
        <div className="flex items-center gap-1.5">
          {isCurrent && (
            <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.5 rounded bg-[#39FF14] text-black flex-shrink-0">
              Diputar
            </span>
          )}
          <h4
            className={`text-xs sm:text-sm font-semibold truncate leading-tight ${
              isCurrent ? "text-[#39FF14]" : isPlayed ? "text-white/70" : "text-white"
            }`}
          >
            {meta.title}
          </h4>
        </div>
        <p
          className={`text-xs font-medium truncate mt-0.5 ${
            isCurrent ? "text-white/90" : isPlayed ? "text-white/50" : "text-white/80"
          }`}
        >
          {meta.artist}
        </p>
        <p className="text-[11px] text-[#8E8E93] truncate mt-0.5">
          {meta.channelInfo}
        </p>
      </button>

      {/* Remove Track Button */}
      <button
        disabled={isRemoving}
        onClick={async () => {
          setIsRemoving(true);
          try { await removeTrack(track.id); }
          catch { /* rollback handled in hook */ }
          finally { setIsRemoving(false); }
        }}
        className="opacity-0 group-hover:opacity-100 p-2 rounded-xl hover:bg-[#FF3B30]/15 text-[#8E8E93] hover:text-[#FF3B30] transition-default disabled:opacity-40 flex-shrink-0 min-h-[36px] cursor-pointer"
        aria-label="Hapus lagu dari playlist"
        title="Hapus"
      >
        {isRemoving ? (
          <span className="text-xs">…</span>
        ) : (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default function PlaylistDetailPage() {
  const params = useParams();
  const router = useRouter();
  const playlistId = params?.id as string;

  const {
    playlists,
    activePlaylist,
    activeTracks,
    isTracksLoading,
    openPlaylist,
    reorderTracks,
  } = usePlaylistContext();
  const { playPlaylist, currentTrack, isPlaying, toggle } = usePlayer();

  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex,     setDropIndex]     = useState<number | null>(null);
  const [announcement,  setAnnouncement]  = useState<string>("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Load target playlist if not active
  useEffect(() => {
    if (!playlistId) return;
    const target = playlists.find((p) => p.id === playlistId);
    if (target && activePlaylist?.id !== playlistId) {
      void openPlaylist(target);
    }
  }, [playlistId, playlists, activePlaylist, openPlaylist]);

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
        setAnnouncement(`Memindahkan ${moved.title} ke posisi ${dropIndex + 1} dari ${newTracks.length}`);
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

  const isThisPlaylistActive =
    activeTracks.length > 0 &&
    activeTracks.some((t) => t.videoId === currentTrack?.videoId);

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

  const handlePlayAllOrToggle = () => {
    if (activeTracks.length === 0) return;
    if (isThisPlaylistActive) {
      toggle();
      return;
    }
    playAll();
  };

  const currentPl = activePlaylist?.id === playlistId ? activePlaylist : playlists.find((p) => p.id === playlistId);

  return (
    <div className="w-full pt-4 pb-36">
      {/* Screen reader announcement region */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      {/* Header: Back Button + Playlist Title + Play All */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/app/playlists"
          className="w-11 h-11 rounded-xl bg-[#161619] border border-white/10 flex items-center justify-center text-[#8E8E93] hover:text-white transition-default flex-shrink-0"
          aria-label="Kembali ke daftar playlist"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </Link>

        <div className="flex-1 min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-white truncate">
            {currentPl?.name || "Daftar Putar"}
          </h1>
          <p className="text-xs sm:text-sm text-[#8E8E93] mt-0.5">
            {activeTracks.length} {activeTracks.length === 1 ? "lagu" : "lagu"}
          </p>
        </div>

        {activeTracks.length > 0 && (
          <button
            onClick={handlePlayAllOrToggle}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#39FF14] text-black text-xs font-bold shadow-md hover:bg-[#57FF38] active:scale-95 transition-default cursor-pointer min-h-[44px] flex-shrink-0"
            aria-label={
              isThisPlaylistActive && isPlaying
                ? "Jeda pemutaran"
                : isThisPlaylistActive
                ? "Lanjutkan pemutaran"
                : "Putar semua lagu di playlist"
            }
          >
            {isThisPlaylistActive && isPlaying ? (
              <>
                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                  <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                </svg>
                <span>Jeda</span>
              </>
            ) : isThisPlaylistActive && !isPlaying ? (
              <>
                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Lanjutkan</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Putar Semua</span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Track List */}
      {isTracksLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 rounded-2xl bg-[#121214] border border-white/5 animate-pulse" />
          ))}
        </div>
      ) : activeTracks.length === 0 ? (
        <div className="text-center py-20 px-4">
          <div className="w-14 h-14 rounded-2xl bg-[#161619] border border-white/10 flex items-center justify-center mx-auto mb-3 text-[#8E8E93]">
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
          </div>
          <p className="text-base font-bold text-white">Playlist ini masih kosong</p>
          <p className="text-xs text-[#8E8E93] mt-1 max-w-xs mx-auto">
            Cari musik atau podcast di tab Cari, lalu ketuk tanda tambah (+) untuk menambahkannya ke sini.
          </p>
          <button
            onClick={() => router.push("/app")}
            className="mt-5 px-4 py-2.5 rounded-xl bg-[#222226] hover:bg-[#2d2d33] text-[#39FF14] text-xs font-bold transition-default"
          >
            Mulai Cari Lagu →
          </button>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="space-y-1.5"
          style={{ touchAction: draggingIndex !== null ? "none" : undefined }}
          onPointerMove={(e) => {
            if (draggingIndex !== null) handleMoveDrag(e.clientY);
          }}
          onPointerUp={() => {
            if (draggingIndex !== null) handleEndDrag();
          }}
          onPointerCancel={() => {
            if (draggingIndex !== null) handleCancelDrag();
          }}
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
