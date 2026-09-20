// ============================================
// DENGARKAN — Continuous Player Tests
// ============================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContinuousStreamUrl,
  getContinuousTrackOffset,
  mapContinuousTimeToTrack,
  isIosOrMobileWebKit,
} from './continuous-player.ts';
import type { PlayableTrack } from './use-audio-engine';

const track1: PlayableTrack = {
  videoId: 'kJQP7kiw5Fk',
  title: 'Despacito',
  channelName: 'Luis Fonsi',
  durationSeconds: 215,
  thumbnailUrl: 'https://example.com/thumb1.jpg',
};

const track2: PlayableTrack = {
  videoId: 'fJ9rUzIMcZQ',
  title: 'Bohemian Rhapsody',
  channelName: 'Queen',
  durationSeconds: 200,
  thumbnailUrl: 'https://example.com/thumb2.jpg',
};

const track3: PlayableTrack = {
  videoId: '3JZ_D3ELwOQ',
  title: 'Radio Ga Ga',
  channelName: 'Queen',
  durationSeconds: 343,
  thumbnailUrl: 'https://example.com/thumb3.jpg',
};

describe('Continuous Player — buildContinuousStreamUrl', () => {
  it('returns empty string when tracks array is empty', () => {
    assert.equal(buildContinuousStreamUrl([]), '');
  });

  it('builds valid continuous stream URL with tracks encoded', () => {
    const url = buildContinuousStreamUrl([track1, track2], 0);
    assert.ok(url.startsWith('/api/audio/continuous?'));
    assert.ok(url.includes('kJQP7kiw5Fk%3A215%3ADespacito%3ALuis%2520Fonsi'));
    assert.ok(url.includes('fJ9rUzIMcZQ%3A200%3ABohemian%2520Rhapsody%3AQueen'));
  });

  it('slices correctly with startIndex', () => {
    const url = buildContinuousStreamUrl([track1, track2], 1);
    assert.ok(!url.includes('kJQP7kiw5Fk'));
    assert.ok(url.includes('fJ9rUzIMcZQ'));
  });

  it('appends token when provided', () => {
    const url = buildContinuousStreamUrl([track1], 0, 'session-token-123');
    assert.ok(url.includes('token=session-token-123'));
  });
});

describe('Continuous Player — getContinuousTrackOffset', () => {
  it('returns 0 for index 0 or negative', () => {
    assert.equal(getContinuousTrackOffset([track1, track2], 0), 0);
    assert.equal(getContinuousTrackOffset([track1, track2], -1), 0);
  });

  it('returns duration of first track for index 1', () => {
    assert.equal(getContinuousTrackOffset([track1, track2], 1), 215);
  });

  it('returns cumulative durations for index 2', () => {
    assert.equal(getContinuousTrackOffset([track1, track2, track3], 2), 415);
  });
});

describe('Continuous Player — mapContinuousTimeToTrack', () => {
  const tracks = [track1, track2, track3];

  it('maps time within first track', () => {
    const pos = mapContinuousTimeToTrack(tracks, 50);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 0);
    assert.equal(pos.track.videoId, 'kJQP7kiw5Fk');
    assert.equal(pos.trackTime, 50);
    assert.equal(pos.isLastTrack, false);
  });

  it('maps time exactly at boundary to second track', () => {
    const pos = mapContinuousTimeToTrack(tracks, 215);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 1);
    assert.equal(pos.track.videoId, 'fJ9rUzIMcZQ');
    assert.equal(pos.trackTime, 0);
    assert.equal(pos.isLastTrack, false);
  });

  it('maps time within second track', () => {
    const pos = mapContinuousTimeToTrack(tracks, 250);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 1);
    assert.equal(pos.trackTime, 35);
  });

  it('maps time beyond all tracks to last track clamped', () => {
    const pos = mapContinuousTimeToTrack(tracks, 1000);
    assert.ok(pos);
    assert.equal(pos.trackIndex, 2);
    assert.equal(pos.track.videoId, '3JZ_D3ELwOQ');
    assert.equal(pos.trackTime, 343);
    assert.equal(pos.isLastTrack, true);
  });
});

describe('Continuous Player — Seek Contract and Multi-Track Transitions', () => {
  it('builds URL with seek parameter for seeking within a track', () => {
    const url = buildContinuousStreamUrl([track2, track3], 0, undefined, 'test-session', 150);
    assert.ok(url.includes('seek=150'));
    assert.ok(url.includes('sessionId=test-session'));
    assert.ok(url.includes('fJ9rUzIMcZQ'));
  });

  it('preserves accurate track progress after seek into track 2', () => {
    // When seeking into track 2 at 150s (duration 200s), stream starts with [track2, track3]
    const streamTracks = [track2, track3];
    const initialSeek = 150;

    // Immediately after seek (audio.currentTime = 0):
    const atSeek = mapContinuousTimeToTrack(streamTracks, 0 + initialSeek);
    assert.ok(atSeek);
    assert.equal(atSeek.track.videoId, track2.videoId);
    assert.equal(atSeek.trackTime, 150);

    // 30 seconds after seek (audio.currentTime = 30):
    const at30 = mapContinuousTimeToTrack(streamTracks, 30 + initialSeek);
    assert.ok(at30);
    assert.equal(at30.track.videoId, track2.videoId);
    assert.equal(at30.trackTime, 180);

    // 55 seconds after seek (audio.currentTime = 55, total 205 > track2 duration 200):
    // Should naturally cross into track3 at 5s!
    const at55 = mapContinuousTimeToTrack(streamTracks, 55 + initialSeek);
    assert.ok(at55);
    assert.equal(at55.track.videoId, track3.videoId);
    assert.equal(at55.trackIndex, 1);
    assert.equal(at55.trackTime, 5);
  });

  it('builds URL with repeat=one or repeat=all parameter', () => {
    const urlOne = buildContinuousStreamUrl([track1], 0, undefined, 'sid1', undefined, 'one');
    assert.ok(urlOne.includes('repeat=one'));

    const urlAll = buildContinuousStreamUrl([track1, track2], 0, undefined, 'sid2', undefined, 'all');
    assert.ok(urlAll.includes('repeat=all'));
  });

  it('repeat=one loops seamlessly within current track', () => {
    // track1 duration: 215s
    // At 250s (past first play), time wraps to 35s of track1
    const pos = mapContinuousTimeToTrack([track1], 250, 'one');
    assert.ok(pos);
    assert.equal(pos.trackIndex, 0);
    assert.equal(pos.track.videoId, track1.videoId);
    assert.equal(pos.trackTime, 35);
  });

  it('repeat=all wraps around to beginning of playlist when cycle finishes', () => {
    // track1 (215s) + track2 (200s) = 415s cycle
    // At 450s, 450 % 415 = 35s into track1 (first track)
    const pos = mapContinuousTimeToTrack([track1, track2], 450, 'all');
    assert.ok(pos);
    assert.equal(pos.trackIndex, 0);
    assert.equal(pos.track.videoId, track1.videoId);
    assert.equal(pos.trackTime, 35);
  });
});
