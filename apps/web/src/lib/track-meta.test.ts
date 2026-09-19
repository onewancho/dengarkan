import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTrackMeta, formatDuration } from "./track-meta.ts";

describe("Track Metadata Parser (parseTrackMeta)", () => {
  it("formats seconds into m:ss and h:mm:ss correctly", () => {
    assert.equal(formatDuration(0), "Live");
    assert.equal(formatDuration(65), "1:05");
    assert.equal(formatDuration(213), "3:33");
    assert.equal(formatDuration(3665), "1:01:05");
  });

  it("extracts Artist - Title correctly when format is 'Artist - Title'", () => {
    const meta = parseTrackMeta("Tulus - Hati-Hati di Jalan (Official Music Video)", "Tulus", 242);
    assert.equal(meta.title, "Hati-Hati di Jalan");
    assert.equal(meta.artist, "Tulus");
    assert.equal(meta.channelInfo, "Tulus - 4:02");
  });

  it("cleans [MV], (Official Audio), (Visualizer) from titles", () => {
    const meta1 = parseTrackMeta("Coldplay - Yellow [Official Video]", "Coldplay", 269);
    assert.equal(meta1.title, "Yellow");
    assert.equal(meta1.artist, "Coldplay");
    assert.equal(meta1.channelInfo, "Coldplay - 4:29");

    const meta2 = parseTrackMeta("Sheila On 7 - Dan (Official Audio)", "Sony Music ID", 280);
    assert.equal(meta2.title, "Dan");
    assert.equal(meta2.artist, "Sheila On 7");
    assert.equal(meta2.channelInfo, "Sony Music ID - 4:40");
  });

  it("handles 'Title - Artist' pattern when channel name matches second part", () => {
    const meta = parseTrackMeta("Sialan - Mahalini (Lyric Video)", "Mahalini", 230);
    assert.equal(meta.title, "Sialan");
    assert.equal(meta.artist, "Mahalini");
    assert.equal(meta.channelInfo, "Mahalini - 3:50");
  });

  it("strips wrapping quotes from title and artist", () => {
    const meta = parseTrackMeta(`Juicy Luicy - "Lantas"`, "Emotion Entertainment", 230);
    assert.equal(meta.title, "Lantas");
    assert.equal(meta.artist, "Juicy Luicy");
    assert.equal(meta.channelInfo, "Emotion Entertainment - 3:50");
  });

  it("falls back gracefully when there is no separator", () => {
    const meta = parseTrackMeta("Bohemian Rhapsody", "Queen Official", 354);
    assert.equal(meta.title, "Bohemian Rhapsody");
    assert.equal(meta.artist, "Queen");
    assert.equal(meta.channelInfo, "Queen Official - 5:54");
  });

  it("cleans - Topic and Official Channel suffixes from channel name", () => {
    const meta = parseTrackMeta("Lagu Santai", "Various Artists - Topic", 180);
    assert.equal(meta.title, "Lagu Santai");
    assert.equal(meta.artist, "Various Artists");
    assert.equal(meta.channelInfo, "Various Artists - Topic - 3:00");
  });
});
