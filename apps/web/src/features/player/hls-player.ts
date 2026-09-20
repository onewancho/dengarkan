// ============================================
// DENGARKAN — HLS Helper Utilities
//
// Manages HLS playlist URL generation, native HLS capability detection,
// and timeline mapping between cumulative HLS playback time and individual tracks.
// ============================================

import type { PlayableTrack } from './use-audio-engine';

export interface TrackTimelinePosition {
  trackIndex: number;
  track: PlayableTrack;
  trackTime: number;
  trackDuration: number;
  isLastTrack: boolean;
}

/**
 * Checks if the current browser environment natively supports HLS (.m3u8) playback
 * via standard HTML5 <audio> elements (e.g. Apple WebKit on iOS Safari, macOS Safari).
 */
export function supportsNativeHls(audio: HTMLAudioElement | null): boolean {
  if (!audio) return false;
  try {
    const canPlay = audio.canPlayType('application/vnd.apple.mpegurl');
    return canPlay === 'probably' || canPlay === 'maybe';
  } catch {
    return false;
  }
}

/**
 * Self-contained Fisher-Yates shuffle for track arrays to prevent circular imports.
 */
function shuffleTracks(items: PlayableTrack[]): PlayableTrack[] {
  if (items.length <= 1) return [...items];
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Builds the exact linear sequence of tracks to be fed into the continuous HLS playlist.
 * Handles queue continuation, repeat all looping (up to ~30 tracks of unbroken playback),
 * and random shuffle order.
 */
export function buildPlaybackSequence(
  current: PlayableTrack,
  queue: PlayableTrack[],
  history: PlayableTrack[],
  repeatMode: 'none' | 'one' | 'all',
  shuffleOn: boolean
): PlayableTrack[] {
  if (repeatMode === 'one') {
    return [current];
  }

  let upcoming = [...queue];
  if (shuffleOn && upcoming.length > 1) {
    upcoming = shuffleTracks(upcoming);
  }

  if (repeatMode === 'all') {
    let fullCycle = [current, ...upcoming];
    if (history.length > 0) {
      const histChronological = [...history].reverse();
      fullCycle = [current, ...upcoming, ...histChronological];
    }
    if (shuffleOn && fullCycle.length > 2) {
      const rest = shuffleTracks(fullCycle.slice(1));
      fullCycle = [fullCycle[0], ...rest];
    }
    let loopList = [...fullCycle];
    const targetCount = Math.max(10, Math.min(40, Math.ceil(30 / Math.max(1, fullCycle.length)) * fullCycle.length));
    while (loopList.length < targetCount && loopList.length < 50) {
      loopList = loopList.concat(fullCycle);
    }
    return loopList;
  }

  return [current, ...upcoming];
}

/**
 * Builds the dynamic HLS playlist URL for the Fastify backend.
 */
export function buildHlsPlaylistUrl(
  tracks: PlayableTrack[],
  startIndex: number = 0,
  token?: string
): string {
  if (tracks.length === 0) return '';

  const validStart = Math.max(0, Math.min(startIndex, tracks.length - 1));
  const activeSlice = tracks.slice(validStart);

  const encodedItems = activeSlice.map((t) => {
    const videoId = t.videoId;
    const dur = Math.max(1, Math.round(t.durationSeconds || 180));
    const title = encodeURIComponent(t.title || '');
    const artist = encodeURIComponent(t.channelName || '');
    return `${videoId}:${dur}:${title}:${artist}`;
  });

  const queryParams = new URLSearchParams({
    tracks: encodedItems.join(','),
    start: '0',
  });

  if (token) {
    queryParams.set('token', token);
  }

  return `/api/audio/hls/playlist.m3u8?${queryParams.toString()}`;
}

/**
 * Calculates the start offset timestamp in the cumulative HLS timeline for a track at index.
 */
export function getTrackStartOffset(tracks: PlayableTrack[], index: number): number {
  if (index <= 0 || tracks.length === 0) return 0;
  const bound = Math.min(index, tracks.length);
  let total = 0;
  for (let i = 0; i < bound; i++) {
    total += Math.max(1, tracks[i].durationSeconds || 180);
  }
  return total;
}

/**
 * Maps a cumulative HLS playback time (in seconds) to the corresponding individual track
 * and elapsed time within that track.
 */
export function mapHlsTimeToTrack(
  tracks: PlayableTrack[],
  cumulativeTime: number
): TrackTimelinePosition | null {
  if (tracks.length === 0) return null;

  const validTime = Math.max(0, cumulativeTime);
  let accumulated = 0;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const dur = Math.max(1, track.durationSeconds || 180);
    const nextAccumulated = accumulated + dur;

    // If within this track's window or on the last track
    if (validTime < nextAccumulated || i === tracks.length - 1) {
      const trackTime = Math.max(0, Math.min(validTime - accumulated, dur));
      return {
        trackIndex: i,
        track,
        trackTime,
        trackDuration: dur,
        isLastTrack: i === tracks.length - 1,
      };
    }

    accumulated = nextAccumulated;
  }

  const lastTrack = tracks[tracks.length - 1];
  return {
    trackIndex: tracks.length - 1,
    track: lastTrack,
    trackTime: lastTrack.durationSeconds || 180,
    trackDuration: lastTrack.durationSeconds || 180,
    isLastTrack: true,
  };
}
