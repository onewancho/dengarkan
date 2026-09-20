// ============================================
// DENGARKAN — Audio Module: HLS Streaming Service
//
// Provides continuous HLS (HTTP Live Streaming) playlist generation
// and lossless ADTS AAC segment streaming via ffmpeg-static.
//
// Solves iOS WebKit Bug 173332 (JavaScript suspension on locked screen)
// by delegating track transitions to the native iOS AVPlayer / mediaserverd.
// ============================================

import { spawn, type ChildProcess } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { audioResolver } from './resolver.js';
import { ResolverError } from './errors.js';

export interface HlsTrack {
  videoId: string;
  durationSeconds: number;
  title?: string;
  artist?: string;
}

/**
 * Generates an RFC 8216 compliant HLS VOD playlist.
 * Uses #EXT-X-DISCONTINUITY between tracks so AVPlayer seamlessly transitions
 * across audio boundaries without stopping when the screen is locked.
 */
export function generateHlsPlaylist(
  tracks: HlsTrack[],
  startIndex: number = 0,
  token?: string
): string {
  const validStartIndex = Math.max(0, Math.min(startIndex, Math.max(0, tracks.length - 1)));
  const slicedTracks = tracks.slice(validStartIndex);

  if (slicedTracks.length === 0) {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:0',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-ENDLIST',
    ].join('\n');
  }

  const maxDuration = Math.max(...slicedTracks.map((t) => Math.ceil(t.durationSeconds || 10)), 10);
  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${maxDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];

  slicedTracks.forEach((track, index) => {
    if (index > 0) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    const duration = (track.durationSeconds && track.durationSeconds > 0)
      ? track.durationSeconds.toFixed(2)
      : '180.00';
    const title = (track.title || 'Track').replace(/[\r\n,]/g, ' ').trim();
    lines.push(`#EXTINF:${duration},${title}`);

    const queryParams = new URLSearchParams();
    if (track.title) queryParams.set('title', track.title);
    if (track.artist) queryParams.set('artist', track.artist);
    if (token) queryParams.set('token', token);

    const queryString = queryParams.toString();
    const segmentUri = `/api/audio/hls/segment/${encodeURIComponent(track.videoId)}.aac${queryString ? `?${queryString}` : ''}`;
    lines.push(segmentUri);
  });

  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

/**
 * Streams a single track as a bit-for-bit ADTS AAC audio segment using ffmpeg-static.
 * Uses -c:a copy to extract the native AAC frames from YouTube's MP4 container
 * with ZERO transcoding loss and sub-millisecond overhead.
 */
export async function streamHlsSegment(
  videoId: string,
  meta: { title?: string; artist?: string },
  request: FastifyRequest,
  reply: FastifyReply
): Promise<unknown> {
  if (!ffmpegPath) {
    request.log.error('ffmpeg-static binary path is not available');
    return reply.status(500).send({
      error: 'SERVER_ERROR',
      message: 'Media processor is not available',
      statusCode: 500,
    });
  }

  let streamUrl: string;
  try {
    const stream = await audioResolver.resolve(videoId);
    streamUrl = stream.streamUrl;
  } catch (err) {
    if (err instanceof ResolverError) {
      return reply.status(err.code === 'VIDEO_NOT_FOUND' ? 404 : 502).send({
        error: err.code,
        message: err.message,
        statusCode: err.code === 'VIDEO_NOT_FOUND' ? 404 : 502,
      });
    }
    throw err;
  }

  const ffmpegArgs: string[] = [
    '-loglevel', 'error',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', streamUrl,
    '-c:a', 'copy',
    '-id3v2_version', '3',
  ];

  if (meta.title) {
    ffmpegArgs.push('-metadata', `title=${meta.title}`);
  }
  if (meta.artist) {
    ffmpegArgs.push('-metadata', `artist=${meta.artist}`);
  }

  ffmpegArgs.push('-f', 'adts', 'pipe:1');

  let ffmpegProcess: ChildProcess | null = null;

  try {
    ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnError) {
    request.log.error({ err: spawnError }, 'Failed to spawn ffmpeg-static');
    return reply.status(500).send({
      error: 'PROCESS_ERROR',
      message: 'Failed to initialize audio stream processor',
      statusCode: 500,
    });
  }

  if (!ffmpegProcess || !ffmpegProcess.stdout || !ffmpegProcess.stderr) {
    return reply.status(500).send({
      error: 'STREAM_ERROR',
      message: 'Failed to open audio streams',
      statusCode: 500,
    });
  }

  const proc = ffmpegProcess;
  const stdout = ffmpegProcess.stdout;
  const stderr = ffmpegProcess.stderr;

  const killProcess = () => {
    if (ffmpegProcess && !ffmpegProcess.killed) {
      try {
        ffmpegProcess.kill('SIGKILL');
      } catch {
        // Process already terminated
      }
      ffmpegProcess = null;
    }
  };

  request.raw.on('close', killProcess);
  request.raw.on('aborted', killProcess);

  stderr.on('data', (data: Buffer) => {
    request.log.warn({ ffmpegStderr: data.toString().trim() }, 'ffmpeg stderr output');
  });

  proc.on('error', (procErr) => {
    request.log.error({ err: procErr }, 'ffmpeg process error');
    killProcess();
  });

  proc.on('close', (_code) => {
    killProcess();
  });

  reply.header('Content-Type', 'audio/aac');
  reply.header('Cache-Control', 'public, max-age=3600');
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('X-Content-Type-Options', 'nosniff');

  return reply.send(stdout);
}
