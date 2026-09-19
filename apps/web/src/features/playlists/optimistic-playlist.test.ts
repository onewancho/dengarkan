// ============================================
// DENGARKAN — Optimistic UI & Drag/Drop Tests
//
// Tests the full optimistic state machine:
//   • beforeState → optimisticState → serverRequest → success / rollback
//   • Rollback on server / network failure + notification trigger
//   • Race conditions & out-of-order latency protection
//   • Rapid multiple reorders with monotonic sequence numbers
//   • Accessible moveUp / moveDown boundary mechanics
//   • Mobile pointer drag-to-index calculation
// ============================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Playlist, PlaylistTrack, SearchResult } from "@dengarkan/shared";

// ── Mock Factory Helpers ──────────────────────────────────────────────────────

function makeTrack(id: string, title: string, position: number): PlaylistTrack {
  return {
    id,
    playlistId: "pl-1",
    videoId: `vid-${id}`,
    title,
    channelName: "Test Channel",
    thumbnailUrl: "https://i.ytimg.com/vi/test/hqdefault.jpg",
    durationSeconds: 180,
    position,
    addedAt: new Date().toISOString(),
  };
}

function makeSearchResult(videoId: string, title: string): SearchResult {
  return {
    videoId,
    title,
    channelName: "Test Channel",
    thumbnailUrl: "https://i.ytimg.com/vi/test/hqdefault.jpg",
    durationSeconds: 200,
    durationFormatted: "3:20",
  };
}

function makePlaylist(id: string, name: string, trackCount = 0): Playlist {
  return {
    id,
    name,
    position: 0,
    trackCount,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ── Optimistic State Machine Implementation (Unit Mirror) ─────────────────────

class OptimisticPlaylistManager {
  playlists: Playlist[];
  activeTracks: PlaylistTrack[];
  activePlaylist: Playlist | null;
  notifications: Array<{ message: string; type: string }> = [];

  reorderSeq = 0;
  fetchSeq = 0;
  beforeReorder: PlaylistTrack[] = [];

  constructor(playlists: Playlist[] = [], activeTracks: PlaylistTrack[] = [], activePlaylist: Playlist | null = null) {
    this.playlists = playlists;
    this.activeTracks = activeTracks;
    this.activePlaylist = activePlaylist;
  }

  notify(message: string, type: "error" | "success" | "info") {
    this.notifications.push({ message, type });
  }

  // 1. Optimistic Add Track
  async addTrack(
    playlistId: string,
    track: SearchResult,
    serverCall: (plId: string, t: SearchResult) => Promise<PlaylistTrack>
  ): Promise<void> {
    // beforeState
    const beforeTracks = [...this.activeTracks];
    const beforePlaylists = [...this.playlists];

    // optimisticState
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const optimisticTrack: PlaylistTrack = {
      id: tempId,
      playlistId,
      videoId: track.videoId,
      title: track.title,
      channelName: track.channelName,
      thumbnailUrl: track.thumbnailUrl,
      durationSeconds: track.durationSeconds,
      position: beforeTracks.length,
      addedAt: new Date().toISOString(),
    };

    if (this.activePlaylist?.id === playlistId) {
      this.activeTracks = [...this.activeTracks, optimisticTrack];
    }
    this.playlists = this.playlists.map((p) =>
      p.id === playlistId ? { ...p, trackCount: p.trackCount + 1 } : p
    );

    // serverRequest
    try {
      const real = await serverCall(playlistId, track);
      // success: swap temp ID with real ID
      if (this.activePlaylist?.id === playlistId) {
        this.activeTracks = this.activeTracks.map((t) => (t.id === tempId ? real : t));
      }
      this.notify("Track added to playlist", "success");
    } catch (err) {
      // rollback
      if (this.activePlaylist?.id === playlistId) {
        this.activeTracks = beforeTracks;
      }
      this.playlists = beforePlaylists;
      this.notify("Failed to add track. Changes reverted.", "error");
      throw err;
    }
  }

  // 2. Optimistic Remove Track
  async removeTrack(
    trackId: string,
    serverCall: (plId: string, trkId: string) => Promise<void>
  ): Promise<void> {
    const pl = this.activePlaylist;
    if (!pl) return;

    // beforeState
    const beforeTracks = [...this.activeTracks];
    const beforePlaylists = [...this.playlists];

    // optimisticState
    this.activeTracks = this.activeTracks.filter((t) => t.id !== trackId);
    this.playlists = this.playlists.map((p) =>
      p.id === pl.id ? { ...p, trackCount: Math.max(0, p.trackCount - 1) } : p
    );

    // serverRequest
    try {
      await serverCall(pl.id, trackId);
      this.notify("Track removed from playlist", "info");
    } catch (err) {
      // rollback
      this.activeTracks = beforeTracks;
      this.playlists = beforePlaylists;
      this.notify("Failed to remove track. Changes reverted.", "error");
      throw err;
    }
  }

  // 3. Optimistic Reorder with Monotonic Sequence Guard
  async reorderTracks(
    trackIds: string[],
    serverCall: (plId: string, ids: string[]) => Promise<void>
  ): Promise<void> {
    const pl = this.activePlaylist;
    if (!pl) return;

    if (this.beforeReorder.length === 0) {
      this.beforeReorder = [...this.activeTracks];
    }

    // 1. optimisticState (instant UI update)
    const map = new Map(this.activeTracks.map((t) => [t.id, t]));
    const reordered: PlaylistTrack[] = [];
    for (let i = 0; i < trackIds.length; i++) {
      const t = map.get(trackIds[i]!);
      if (t) reordered.push({ ...t, position: i });
    }
    this.activeTracks = reordered;

    // 2. Monotonic sequence counter
    const currentSeq = ++this.reorderSeq;

    // 3. serverRequest
    try {
      await serverCall(pl.id, trackIds);
      if (currentSeq === this.reorderSeq) {
        this.beforeReorder = [...reordered];
      }
    } catch (err) {
      // Only rollback if this is still the active (latest) reorder
      if (currentSeq === this.reorderSeq) {
        this.activeTracks = [...this.beforeReorder];
        this.beforeReorder = [];
        this.notify("Failed to reorder tracks. Changes reverted.", "error");
      }
      throw err;
    }
  }

  // Accessible move helpers
  async moveTrackUp(index: number, serverCall: (plId: string, ids: string[]) => Promise<void>): Promise<void> {
    if (index <= 0 || index >= this.activeTracks.length) return;
    const newIds = this.activeTracks.map((t) => t.id);
    const temp = newIds[index]!;
    newIds[index] = newIds[index - 1]!;
    newIds[index - 1] = temp;
    await this.reorderTracks(newIds, serverCall);
  }

  async moveTrackDown(index: number, serverCall: (plId: string, ids: string[]) => Promise<void>): Promise<void> {
    if (index < 0 || index >= this.activeTracks.length - 1) return;
    const newIds = this.activeTracks.map((t) => t.id);
    const temp = newIds[index]!;
    newIds[index] = newIds[index + 1]!;
    newIds[index + 1] = temp;
    await this.reorderTracks(newIds, serverCall);
  }

  // 4. Optimistic Rename
  async renamePlaylist(
    id: string,
    name: string,
    serverCall: (id: string, name: string) => Promise<void>
  ): Promise<void> {
    const beforePlaylists = [...this.playlists];
    const beforeActive = this.activePlaylist ? { ...this.activePlaylist } : null;

    this.playlists = this.playlists.map((p) => (p.id === id ? { ...p, name } : p));
    if (this.activePlaylist?.id === id) {
      this.activePlaylist = { ...this.activePlaylist, name };
    }

    try {
      await serverCall(id, name);
      this.notify("Playlist renamed", "success");
    } catch (err) {
      this.playlists = beforePlaylists;
      this.activePlaylist = beforeActive;
      this.notify("Failed to rename playlist. Changes reverted.", "error");
      throw err;
    }
  }

  // 5. Optimistic Delete
  async deletePlaylist(
    id: string,
    serverCall: (id: string) => Promise<void>
  ): Promise<void> {
    const beforePlaylists = [...this.playlists];
    const beforeActive = this.activePlaylist ? { ...this.activePlaylist } : null;
    const beforeTracks = [...this.activeTracks];

    this.playlists = this.playlists.filter((p) => p.id !== id);
    if (this.activePlaylist?.id === id) {
      this.activePlaylist = null;
      this.activeTracks = [];
    }

    try {
      await serverCall(id);
      this.notify("Playlist deleted", "info");
    } catch (err) {
      this.playlists = beforePlaylists;
      this.activePlaylist = beforeActive;
      this.activeTracks = beforeTracks;
      this.notify("Failed to delete playlist. Changes reverted.", "error");
      throw err;
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Optimistic UI — Add Track", () => {
  it("immediately appends optimistic track before server response", async () => {
    const pl = makePlaylist("pl-1", "My Playlist");
    const manager = new OptimisticPlaylistManager([pl], [], pl);

    let resolveServer!: (t: PlaylistTrack) => void;
    const serverPromise = new Promise<PlaylistTrack>((res) => { resolveServer = res; });

    const searchResult = makeSearchResult("vid-1", "Song One");
    const addPromise = manager.addTrack("pl-1", searchResult, () => serverPromise);

    // Assert optimistic state immediately visible
    assert.equal(manager.activeTracks.length, 1);
    assert.ok(manager.activeTracks[0]!.id.startsWith("temp-"));
    assert.equal(manager.activeTracks[0]!.title, "Song One");
    assert.equal(manager.playlists[0]!.trackCount, 1);

    // Resolve server
    const realTrack = makeTrack("real-track-id", "Song One", 0);
    resolveServer(realTrack);
    await addPromise;

    // Real ID swapped in
    assert.equal(manager.activeTracks[0]!.id, "real-track-id");
    assert.equal(manager.notifications.some(n => n.type === "success"), true);
  });

  it("rollback on server failure: restores beforeState and notifies user", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 0);
    const manager = new OptimisticPlaylistManager([pl], [], pl);

    const searchResult = makeSearchResult("vid-err", "Failing Song");

    await assert.rejects(
      async () => {
        await manager.addTrack("pl-1", searchResult, async () => {
          throw new Error("500 Internal Server Error");
        });
      },
      { message: "500 Internal Server Error" }
    );

    // Assert rolled back
    assert.equal(manager.activeTracks.length, 0);
    assert.equal(manager.playlists[0]!.trackCount, 0);
    assert.ok(manager.notifications.some(n => n.type === "error" && n.message.includes("reverted")));
  });
});

describe("Optimistic UI — Remove Track", () => {
  it("immediately removes track from list and decrements trackCount", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 2);
    const t1 = makeTrack("t-1", "Song 1", 0);
    const t2 = makeTrack("t-2", "Song 2", 1);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2], pl);

    let resolveServer!: () => void;
    const serverPromise = new Promise<void>((res) => { resolveServer = res; });

    const removePromise = manager.removeTrack("t-1", () => serverPromise);

    // Optimistically removed
    assert.equal(manager.activeTracks.length, 1);
    assert.equal(manager.activeTracks[0]!.id, "t-2");
    assert.equal(manager.playlists[0]!.trackCount, 1);

    resolveServer();
    await removePromise;
    assert.equal(manager.notifications.some(n => n.type === "info"), true);
  });

  it("rollback on server failure: restores track and trackCount, notifies user", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 2);
    const t1 = makeTrack("t-1", "Song 1", 0);
    const t2 = makeTrack("t-2", "Song 2", 1);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2], pl);

    await assert.rejects(
      async () => {
        await manager.removeTrack("t-1", async () => {
          throw new Error("Network offline");
        });
      },
      { message: "Network offline" }
    );

    // Rolled back to exact original state
    assert.equal(manager.activeTracks.length, 2);
    assert.equal(manager.activeTracks[0]!.id, "t-1");
    assert.equal(manager.playlists[0]!.trackCount, 2);
    assert.ok(manager.notifications.some(n => n.type === "error" && n.message.includes("reverted")));
  });
});

describe("Optimistic UI — Reorder & Drag/Drop", () => {
  it("instantly updates order in UI and sets new position values", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 3);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const t3 = makeTrack("t-3", "C", 2);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2, t3], pl);

    // Reorder C, A, B
    await manager.reorderTracks(["t-3", "t-1", "t-2"], async () => {});

    assert.equal(manager.activeTracks[0]!.id, "t-3");
    assert.equal(manager.activeTracks[0]!.position, 0);
    assert.equal(manager.activeTracks[1]!.id, "t-1");
    assert.equal(manager.activeTracks[1]!.position, 1);
    assert.equal(manager.activeTracks[2]!.id, "t-2");
    assert.equal(manager.activeTracks[2]!.position, 2);
  });

  it("rollback on reorder failure: reverts to beforeReorder snapshot", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 3);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const t3 = makeTrack("t-3", "C", 2);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2, t3], pl);

    await assert.rejects(
      async () => {
        await manager.reorderTracks(["t-3", "t-2", "t-1"], async () => {
          throw new Error("Reorder failed on DB");
        });
      },
      { message: "Reorder failed on DB" }
    );

    // Restores original order
    assert.equal(manager.activeTracks[0]!.id, "t-1");
    assert.equal(manager.activeTracks[1]!.id, "t-2");
    assert.equal(manager.activeTracks[2]!.id, "t-3");
    assert.ok(manager.notifications.some(n => n.type === "error" && n.message.includes("reverted")));
  });
});

describe("Optimistic UI — Accessible Move Up / Down Helpers", () => {
  it("moveTrackUp swaps track with previous track", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 3);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const t3 = makeTrack("t-3", "C", 2);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2, t3], pl);

    await manager.moveTrackUp(1, async () => {}); // Move B up → B, A, C
    assert.equal(manager.activeTracks[0]!.id, "t-2");
    assert.equal(manager.activeTracks[1]!.id, "t-1");
    assert.equal(manager.activeTracks[2]!.id, "t-3");
  });

  it("moveTrackUp at index 0 does nothing (boundary guard)", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 2);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2], pl);

    let called = false;
    await manager.moveTrackUp(0, async () => { called = true; });
    assert.equal(called, false);
    assert.equal(manager.activeTracks[0]!.id, "t-1");
  });

  it("moveTrackDown swaps track with next track", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 3);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const t3 = makeTrack("t-3", "C", 2);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2, t3], pl);

    await manager.moveTrackDown(1, async () => {}); // Move B down → A, C, B
    assert.equal(manager.activeTracks[0]!.id, "t-1");
    assert.equal(manager.activeTracks[1]!.id, "t-3");
    assert.equal(manager.activeTracks[2]!.id, "t-2");
  });

  it("moveTrackDown at last index does nothing (boundary guard)", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 2);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2], pl);

    let called = false;
    await manager.moveTrackDown(1, async () => { called = true; });
    assert.equal(called, false);
    assert.equal(manager.activeTracks[1]!.id, "t-2");
  });
});

describe("Race Conditions & Monotonic Sequence Counter", () => {
  it("rapid reorders: earlier out-of-order failure does not roll back newer state", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 3);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const t3 = makeTrack("t-3", "C", 2);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2, t3], pl);

    let rejectSeq1!: (err: Error) => void;
    let resolveSeq2!: () => void;

    const p1Server = new Promise<void>((_, rej) => { rejectSeq1 = rej; });
    const p2Server = new Promise<void>((res) => { resolveSeq2 = res; });

    // Rapid action 1: Move B up → [B, A, C]
    const action1 = manager.reorderTracks(["t-2", "t-1", "t-3"], () => p1Server);
    assert.equal(manager.activeTracks[0]!.id, "t-2");

    // Rapid action 2: Move C up → [B, C, A]
    const action2 = manager.reorderTracks(["t-2", "t-3", "t-1"], () => p2Server);
    assert.equal(manager.activeTracks[0]!.id, "t-2");
    assert.equal(manager.activeTracks[1]!.id, "t-3");
    assert.equal(manager.activeTracks[2]!.id, "t-1");

    // Action 1 fails LATER (out-of-order rejection)
    rejectSeq1(new Error("Stale failure"));
    await assert.rejects(action1, { message: "Stale failure" });

    // Notice: state should NOT be reverted by stale action 1 failure, because seq is 2!
    assert.equal(manager.activeTracks[0]!.id, "t-2");
    assert.equal(manager.activeTracks[1]!.id, "t-3");
    assert.equal(manager.activeTracks[2]!.id, "t-1");

    // Action 2 succeeds
    resolveSeq2();
    await action2;

    assert.equal(manager.activeTracks[0]!.id, "t-2");
    assert.equal(manager.activeTracks[1]!.id, "t-3");
    assert.equal(manager.activeTracks[2]!.id, "t-1");
  });

  it("rapid deletes: subsequent delete operates on already-updated optimistic list", async () => {
    const pl = makePlaylist("pl-1", "My Playlist", 3);
    const t1 = makeTrack("t-1", "A", 0);
    const t2 = makeTrack("t-2", "B", 1);
    const t3 = makeTrack("t-3", "C", 2);
    const manager = new OptimisticPlaylistManager([pl], [t1, t2, t3], pl);

    // Delete t1, then quickly delete t2
    void manager.removeTrack("t-1", async () => {});
    void manager.removeTrack("t-2", async () => {});

    // Both immediately gone
    assert.equal(manager.activeTracks.length, 1);
    assert.equal(manager.activeTracks[0]!.id, "t-3");
    assert.equal(manager.playlists[0]!.trackCount, 1);
  });
});

describe("Optimistic UI — Rename & Delete Playlist", () => {
  it("rename: optimistic name change + rollback on error", async () => {
    const pl = makePlaylist("pl-1", "Old Name", 1);
    const manager = new OptimisticPlaylistManager([pl], [], pl);

    // Successful rename
    await manager.renamePlaylist("pl-1", "New Name", async () => {});
    assert.equal(manager.playlists[0]!.name, "New Name");
    assert.equal(manager.activePlaylist?.name, "New Name");

    // Failed rename
    await assert.rejects(
      async () => {
        await manager.renamePlaylist("pl-1", "Failing Name", async () => {
          throw new Error("DB lock timeout");
        });
      },
      { message: "DB lock timeout" }
    );

    // Rolled back to "New Name"
    assert.equal(manager.playlists[0]!.name, "New Name");
    assert.equal(manager.activePlaylist?.name, "New Name");
  });

  it("delete: optimistic removal + rollback on error", async () => {
    const pl1 = makePlaylist("pl-1", "List 1", 1);
    const pl2 = makePlaylist("pl-2", "List 2", 2);
    const manager = new OptimisticPlaylistManager([pl1, pl2], [makeTrack("t-1", "A", 0)], pl1);

    // Failed delete on pl1
    await assert.rejects(
      async () => {
        await manager.deletePlaylist("pl-1", async () => {
          throw new Error("Server error");
        });
      },
      { message: "Server error" }
    );

    // Restored
    assert.equal(manager.playlists.length, 2);
    assert.equal(manager.playlists[0]!.id, "pl-1");
    assert.equal(manager.activePlaylist?.id, "pl-1");
    assert.equal(manager.activeTracks.length, 1);
  });
});

describe("Mobile Touch & Pointer Coordinate Calculation", () => {
  it("calculates drop index based on pointer clientY vs item rects", () => {
    // Simulate 4 row bounding boxes: each height 50, tops: 100, 150, 200, 250
    const rowRects = [
      { top: 100, height: 50 }, // mid = 125
      { top: 150, height: 50 }, // mid = 175
      { top: 200, height: 50 }, // mid = 225
      { top: 250, height: 50 }, // mid = 275
    ];

    function calculateDropIndex(clientY: number): number {
      for (let i = 0; i < rowRects.length; i++) {
        const mid = rowRects[i]!.top + rowRects[i]!.height / 2;
        if (clientY < mid) return i;
      }
      return rowRects.length - 1;
    }

    // Pointer above mid of row 0 (e.g. 110) → drop index 0
    assert.equal(calculateDropIndex(110), 0);
    // Pointer below mid of row 0 but above mid of row 1 (e.g. 150) → drop index 1
    assert.equal(calculateDropIndex(150), 1);
    // Pointer at 210 → drop index 2
    assert.equal(calculateDropIndex(210), 2);
    // Pointer at 300 (below all rows) → drop index 3 (last)
    assert.equal(calculateDropIndex(300), 3);
  });
});
