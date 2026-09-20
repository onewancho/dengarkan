// ============================================
// DENGARKAN — Track Metadata Parser Utility
//
// Extracts:
//   1. Judul Lagu (Song Title)
//   2. Penyanyi (Artist / Performer)
//   3. nama channel - durasi (Channel Name - Duration)
// ============================================

export interface TrackMeta {
  title: string;       // Judul Lagu
  artist: string;      // Penyanyi
  channelInfo: string; // nama channel - durasi
  channelName: string; // Clean channel name
  durationFormatted: string; // e.g. "3:45"
}

export function formatDuration(seconds: number | undefined | null): string {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return "Live";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function parseTrackMeta(
  rawTitle: string | undefined | null,
  channelName: string | undefined | null,
  duration?: number | string | null
): TrackMeta {
  const safeChannel = (channelName || "YouTube").trim();
  const cleanChannel = safeChannel
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/\s*Official(\s*Channel)?$/i, "")
    .trim() || safeChannel;

  // Format duration
  let durStr = "";
  if (typeof duration === "string" && duration.trim()) {
    durStr = duration.trim();
  } else if (typeof duration === "number") {
    durStr = formatDuration(duration);
  } else {
    durStr = "Audio";
  }

  // Clean raw title of YouTube clutter
  const raw = (rawTitle || "").trim();
  const cleanClutter = (str: string) =>
    str
      .replace(/\s*[\(\[\{](?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer|mv|clip)?|video\s*(?:clip|klip)|lyrics?\s*(?:video)?|lirik\s*(?:video)?|audio\s*only|official|visualizer|mv|hd|4k|hq)[\)\]\}]/gi, "")
      .replace(/\s*\|.*$/, "") // trailing pipe channel tags
      .trim();

  const cleaned = cleanClutter(raw);

  // Look for standard artist-title separators: " - ", " – ", " — "
  const sepMatch = cleaned.match(/\s+[-–—]\s+/);

  let songTitle = cleaned || raw || "Memuat audio…";
  let artist = cleanChannel;

  if (sepMatch && sepMatch.index !== undefined) {
    const p1 = cleanClutter(cleaned.slice(0, sepMatch.index));
    const p2 = cleanClutter(cleaned.slice(sepMatch.index + sepMatch[0].length));

    if (p1 && p2) {
      const p1Lower = p1.toLowerCase();
      const p2Lower = p2.toLowerCase();
      const chLower = cleanChannel.toLowerCase();

      // If p2 matches the channel name, pattern is "Title - Artist"
      if (chLower.includes(p2Lower) && !chLower.includes(p1Lower)) {
        artist = p2;
        songTitle = p1;
      } else {
        // Standard "Artist - Title"
        artist = p1;
        songTitle = p2;
      }
    }
  }

  // Strip wrapping quotes if any
  songTitle = songTitle.replace(/^["'“‘](.*)["'”’]$/, "$1").trim();
  artist = artist.replace(/^["'“‘](.*)["'”’]$/, "$1").trim();

  if (!songTitle) songTitle = raw || cleanChannel;
  if (!artist) artist = cleanChannel;

  // Build: "nama channel - durasi"
  const channelInfo = durStr ? `${safeChannel} - ${durStr}` : safeChannel;

  return {
    title: songTitle,
    artist,
    channelInfo,
    channelName: safeChannel,
    durationFormatted: durStr,
  };
}
