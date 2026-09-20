import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateHlsPlaylist, type HlsTrack } from './hls.service.js';

describe('HLS Service — generateHlsPlaylist', () => {
  it('returns valid empty playlist when tracks array is empty', () => {
    const playlist = generateHlsPlaylist([]);
    assert.match(playlist, /^#EXTM3U/);
    assert.match(playlist, /#EXT-X-ENDLIST$/);
    assert.ok(playlist.includes('#EXT-X-TARGETDURATION:0'));
  });

  it('generates single track playlist without discontinuity', () => {
    const tracks: HlsTrack[] = [
      { videoId: 'dQw4w9WgXcQ', durationSeconds: 213.08, title: 'Never Gonna Give You Up', artist: 'Rick Astley' },
    ];
    const playlist = generateHlsPlaylist(tracks);

    assert.ok(playlist.includes('#EXTM3U'));
    assert.ok(playlist.includes('#EXT-X-VERSION:3'));
    assert.ok(playlist.includes('#EXT-X-PLAYLIST-TYPE:VOD'));
    assert.ok(playlist.includes('#EXT-X-TARGETDURATION:214'));
    assert.ok(!playlist.includes('#EXT-X-DISCONTINUITY'));
    assert.ok(playlist.includes('#EXTINF:213.08,Never Gonna Give You Up'));
    assert.ok(playlist.includes('/api/audio/hls/segment/dQw4w9WgXcQ.aac?title=Never+Gonna+Give+You+Up&artist=Rick+Astley'));
    assert.ok(playlist.includes('#EXT-X-ENDLIST'));
  });

  it('inserts #EXT-X-DISCONTINUITY between consecutive tracks in queue', () => {
    const tracks: HlsTrack[] = [
      { videoId: 'track111111', durationSeconds: 180, title: 'Song 1', artist: 'Artist 1' },
      { videoId: 'track222222', durationSeconds: 240, title: 'Song 2', artist: 'Artist 2' },
      { videoId: 'track333333', durationSeconds: 200, title: 'Song 3', artist: 'Artist 3' },
    ];
    const playlist = generateHlsPlaylist(tracks);

    const occurrences = (playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length;
    assert.equal(occurrences, 2, 'Should have exactly 2 discontinuities for 3 tracks');

    assert.ok(playlist.includes('/api/audio/hls/segment/track111111.aac'));
    assert.ok(playlist.includes('/api/audio/hls/segment/track222222.aac'));
    assert.ok(playlist.includes('/api/audio/hls/segment/track333333.aac'));
    assert.ok(playlist.includes('#EXT-X-TARGETDURATION:240'));
  });

  it('slices playlist correctly with startIndex', () => {
    const tracks: HlsTrack[] = [
      { videoId: 'track111111', durationSeconds: 180, title: 'Song 1' },
      { videoId: 'track222222', durationSeconds: 240, title: 'Song 2' },
      { videoId: 'track333333', durationSeconds: 200, title: 'Song 3' },
    ];
    const playlist = generateHlsPlaylist(tracks, 1);

    assert.ok(!playlist.includes('track111111.aac'));
    assert.ok(playlist.includes('track222222.aac'));
    assert.ok(playlist.includes('track333333.aac'));
    const occurrences = (playlist.match(/#EXT-X-DISCONTINUITY/g) || []).length;
    assert.equal(occurrences, 1);
  });

  it('appends token parameter to segment URIs when provided', () => {
    const tracks: HlsTrack[] = [
      { videoId: 'track111111', durationSeconds: 180, title: 'Song 1' },
    ];
    const playlist = generateHlsPlaylist(tracks, 0, 'secret-session-token');
    assert.ok(playlist.includes('token=secret-session-token'));
  });
});
