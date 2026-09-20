// ============================================
// DENGARKAN — Continuous Stream Service Tests
// ============================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseContinuousTracks } from './continuous-stream.service.js';

describe('Continuous Stream Service — parseContinuousTracks', () => {
  it('returns empty array when input is undefined or empty', () => {
    assert.deepEqual(parseContinuousTracks(undefined), []);
    assert.deepEqual(parseContinuousTracks(''), []);
    assert.deepEqual(parseContinuousTracks('   '), []);
  });

  it('parses valid JSON array of tracks', () => {
    const input = JSON.stringify([
      { videoId: 'kJQP7kiw5Fk', durationSeconds: 215, title: 'Despacito', artist: 'Luis Fonsi' },
      { videoId: 'fJ9rUzIMcZQ', durationSeconds: 200, title: 'Bohemian Rhapsody', artist: 'Queen' },
    ]);
    const parsed = parseContinuousTracks(input);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].videoId, 'kJQP7kiw5Fk');
    assert.equal(parsed[0].durationSeconds, 215);
    assert.equal(parsed[0].title, 'Despacito');
    assert.equal(parsed[1].videoId, 'fJ9rUzIMcZQ');
  });

  it('parses comma-separated format', () => {
    const input = 'kJQP7kiw5Fk:215:Despacito:Luis%20Fonsi,fJ9rUzIMcZQ:200:Bohemian%20Rhapsody:Queen';
    const parsed = parseContinuousTracks(input);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].videoId, 'kJQP7kiw5Fk');
    assert.equal(parsed[0].durationSeconds, 215);
    assert.equal(parsed[0].title, 'Despacito');
    assert.equal(parsed[0].artist, 'Luis Fonsi');
    assert.equal(parsed[1].videoId, 'fJ9rUzIMcZQ');
    assert.equal(parsed[1].durationSeconds, 200);
    assert.equal(parsed[1].title, 'Bohemian Rhapsody');
    assert.equal(parsed[1].artist, 'Queen');
  });

  it('skips invalid items with wrong videoId length', () => {
    const input = 'invalidId:120:Title,kJQP7kiw5Fk:215:Valid,short:60:TooShort';
    const parsed = parseContinuousTracks(input);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].videoId, 'kJQP7kiw5Fk');
  });
});

describe('Continuous Stream Service — Session Management', () => {
  it('returns false when skipping non-existent session', async () => {
    const { skipContinuousSession } = await import('./continuous-stream.service.js');
    assert.equal(skipContinuousSession('non-existent'), false);
  });

  it('returns false when updating non-existent session queue', async () => {
    const { updateContinuousSessionQueue } = await import('./continuous-stream.service.js');
    assert.equal(updateContinuousSessionQueue('non-existent', []), false);
  });
});
