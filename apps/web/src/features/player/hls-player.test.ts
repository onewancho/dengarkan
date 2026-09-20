import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  supportsNativeHls,
  buildHlsPlaylistUrl,
  getTrackStartOffset,
  mapHlsTimeToTrack,
} from './hls-player.ts';
import type { PlayableTrack } from './use-audio-engine.ts';

function createMockTrack(id: string, duration: number, title: string = 'Title'): PlayableTrack {
  return {
    videoId: id,
    title,
    channelName: 'Channel',
    durationSeconds: duration,
    thumbnailUrl: 'https://example.com/thumb.jpg',
  };
}

describe('HLS Player Helpers — supportsNativeHls', () => {
  it('returns false when audio is null', () => {
    assert.equal(supportsNativeHls(null), false);
  });

  it('returns true when canPlayType returns probably or maybe', () => {
    const audioProbably = { canPlayType: () => 'probably' } as unknown as HTMLAudioElement;
    assert.equal(supportsNativeHls(audioProbably), true);

    const audioMaybe = { canPlayType: () => 'maybe' } as unknown as HTMLAudioElement;
    assert.equal(supportsNativeHls(audioMaybe), true);
  });

  it('returns false when canPlayType returns empty string', () => {
    const audioEmpty = { canPlayType: () => '' } as unknown as HTMLAudioElement;
    assert.equal(supportsNativeHls(audioEmpty), false);
  });
});

describe('HLS Player Helpers — buildHlsPlaylistUrl', () => {
  it('returns empty string when tracks array is empty', () => {
    assert.equal(buildHlsPlaylistUrl([]), '');
  });

  it('builds valid URL with encoded track metadata', () => {
    const tracks = [
      createMockTrack('vid1', 200, 'Song A'),
      createMockTrack('vid2', 180, 'Song B'),
    ];
    const url = buildHlsPlaylistUrl(tracks, 0);

    assert.ok(url.startsWith('/api/audio/hls/playlist.m3u8?'));
    assert.ok(url.includes('vid1%3A200%3ASong%2520A'));
    assert.ok(url.includes('vid2%3A180%3ASong%2520B'));
  });

  it('slices from startIndex when startIndex > 0', () => {
    const tracks = [
      createMockTrack('vid1', 200),
      createMockTrack('vid2', 180),
      createMockTrack('vid3', 240),
    ];
    const url = buildHlsPlaylistUrl(tracks, 1);
    assert.ok(!url.includes('vid1'));
    assert.ok(url.includes('vid2'));
    assert.ok(url.includes('vid3'));
  });

  it('appends token query param when provided', () => {
    const tracks = [createMockTrack('vid1', 200)];
    const url = buildHlsPlaylistUrl(tracks, 0, 'session-abc');
    assert.ok(url.includes('token=session-abc'));
  });
});

describe('HLS Player Helpers — getTrackStartOffset', () => {
  const tracks = [
    createMockTrack('vid1', 200),
    createMockTrack('vid2', 180),
    createMockTrack('vid3', 240),
  ];

  it('returns 0 for first track', () => {
    assert.equal(getTrackStartOffset(tracks, 0), 0);
  });

  it('returns correct cumulative start times for subsequent tracks', () => {
    assert.equal(getTrackStartOffset(tracks, 1), 200);
    assert.equal(getTrackStartOffset(tracks, 2), 380);
  });

  it('handles negative or out of bound indexes safely', () => {
    assert.equal(getTrackStartOffset(tracks, -1), 0);
    assert.equal(getTrackStartOffset(tracks, 10), 620);
  });
});

describe('HLS Player Helpers — mapHlsTimeToTrack', () => {
  const tracks = [
    createMockTrack('vid1', 200, 'Song 1'),
    createMockTrack('vid2', 180, 'Song 2'),
    createMockTrack('vid3', 240, 'Song 3'),
  ];

  it('maps time within first track correctly', () => {
    const pos = mapHlsTimeToTrack(tracks, 50);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 0);
    assert.equal(pos.track.videoId, 'vid1');
    assert.equal(pos.trackTime, 50);
    assert.equal(pos.isLastTrack, false);
  });

  it('maps time exactly at boundary to second track', () => {
    const pos = mapHlsTimeToTrack(tracks, 200);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 1);
    assert.equal(pos.track.videoId, 'vid2');
    assert.equal(pos.trackTime, 0);
  });

  it('maps time within second track correctly', () => {
    const pos = mapHlsTimeToTrack(tracks, 265);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 1);
    assert.equal(pos.track.videoId, 'vid2');
    assert.equal(pos.trackTime, 65);
  });

  it('maps time in last track and clamps if past end', () => {
    const pos = mapHlsTimeToTrack(tracks, 400);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 2);
    assert.equal(pos.track.videoId, 'vid3');
    assert.equal(pos.trackTime, 20);
    assert.equal(pos.isLastTrack, true);

    const pastEnd = mapHlsTimeToTrack(tracks, 700);
    assert.ok(pastEnd);
    assert.equal(pastEnd.trackIndex, 2);
    assert.equal(pastEnd.trackTime, 240);
  });

  it('returns null for empty tracks array', () => {
    assert.equal(mapHlsTimeToTrack([], 100), null);
  });
});
