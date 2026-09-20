// ============================================
// DENGARKAN — Audio Module: Continuous Audio Streaming Service
//
// Streams an entire queue/playlist continuously over a single chunked HTTP response.
// Uses self-synchronizing MP3 frames (192kbps, 44.1kHz stereo)
// so that audio seamlessly transitions across tracks in a single unbroken connection.
//
// Completely eliminates iOS WebKit Bug 173332 / background socket suspension
// because audio.src never changes and the browser never needs to open a new connection.
// ============================================

import { spawn, type ChildProcess } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { audioResolver } from './resolver.js';

export interface ContinuousTrack {
  videoId: string;
  durationSeconds?: number;
  title?: string;
  artist?: string;
}

/**
 * Parses track query parameter into an array of ContinuousTrack items.
 * Supports JSON string or "id:dur:title:artist,id2:dur2..." format.
 */
export function parseContinuousTracks(raw: string | undefined): ContinuousTrack[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // fallback to comma separated format
    }
  }

  const tracks: ContinuousTrack[] = [];
  const items = trimmed.split(',');
  for (const item of items) {
    const parts = item.split(':');
    const videoId = parts[0]?.trim();
    if (videoId && videoId.length === 11) {
      const durationSeconds = parseFloat(parts[1] || '180') || 180;
      const title = parts[2] ? decodeURIComponent(parts[2]) : undefined;
      const artist = parts[3] ? decodeURIComponent(parts[3]) : undefined;
      tracks.push({ videoId, durationSeconds, title, artist });
    }
  }
  return tracks;
}

export interface ContinuousSession {
  sessionId: string;
  tracks: ContinuousTrack[];
  currentIndex: number;
  activeProcess: ChildProcess | null;
  isAborted: boolean;
  skipRequested: boolean;
  nextTrackIndex?: number;
  repeatMode?: 'none' | 'one' | 'all';
}

const activeSessions = new Map<string, ContinuousSession>();

export function getContinuousSession(sessionId: string): ContinuousSession | undefined {
  return activeSessions.get(sessionId);
}

export function skipContinuousSession(sessionId: string, nextIndex?: number): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.skipRequested = true;
  if (typeof nextIndex === 'number') {
    session.nextTrackIndex = nextIndex;
  }
  if (session.activeProcess && !session.activeProcess.killed) {
    try {
      session.activeProcess.kill('SIGTERM');
    } catch {
      // already exited
    }
  }
  return true;
}

export function updateContinuousSessionQueue(sessionId: string, tracks: ContinuousTrack[]): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.tracks = tracks;
  return true;
}

export function setContinuousSessionRepeat(sessionId: string, repeatMode: 'none' | 'one' | 'all'): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.repeatMode = repeatMode;
  return true;
}

/**
 * Streams a sequence of tracks continuously through a single chunked HTTP response.
 */
export async function streamContinuousQueue(
  tracks: ContinuousTrack[],
  startIndex: number,
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId?: string,
  initialSeekSeconds?: number,
  repeatMode?: 'none' | 'one' | 'all'
): Promise<void> {
  if (!ffmpegPath) {
    request.log.error('ffmpeg-static binary path is not available');
    return reply.status(500).send({
      error: 'SERVER_ERROR',
      message: 'Media processor is not available',
      statusCode: 500,
    });
  }

  const validStart = Math.max(0, Math.min(startIndex, Math.max(0, tracks.length - 1)));
  if (tracks.length === 0) {
    return reply.status(400).send({
      error: 'BAD_REQUEST',
      message: 'No valid tracks provided for continuous stream',
      statusCode: 400,
    });
  }

  // Hijack raw response to maintain manual continuous streaming
  reply.hijack();

  const rawRes = reply.raw;
  const sid = sessionId || `cs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const session: ContinuousSession = {
    sessionId: sid,
    tracks,
    currentIndex: validStart,
    activeProcess: null,
    isAborted: false,
    skipRequested: false,
    repeatMode: repeatMode || 'none',
  };

  activeSessions.set(sid, session);

  const cleanup = () => {
    session.isAborted = true;
    if (session.activeProcess && !session.activeProcess.killed) {
      try {
        session.activeProcess.kill('SIGKILL');
      } catch {
        // already exited
      }
      session.activeProcess = null;
    }
    activeSessions.delete(sid);
  };

  rawRes.on('close', cleanup);
  rawRes.on('finish', cleanup);
  rawRes.on('error', cleanup);
  request.raw.on('close', cleanup);
  request.raw.on('aborted', cleanup);

  // Send initial HTTP headers for continuous MP3 streaming
  rawRes.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });

  let isFirstTrack = true;

  while (!session.isAborted && !rawRes.destroyed && !rawRes.writableEnded) {
    if (session.currentIndex >= session.tracks.length) {
      break;
    }

    const currentTrack = session.tracks[session.currentIndex];
    let streamUrl: string;

    try {
      const resolved = await audioResolver.resolve(currentTrack.videoId);
      streamUrl = resolved.streamUrl;
    } catch (err) {
      request.log.warn(
        { videoId: currentTrack.videoId, err },
        'Failed to resolve track in continuous stream — skipping to next'
      );
      session.currentIndex++;
      continue;
    }

    if (session.isAborted || rawRes.destroyed || rawRes.writableEnded) {
      break;
    }

    // Pre-resolve the upcoming track in background so track boundary transitions are 0ms
    const nextIdx = session.currentIndex + 1;
    if (nextIdx < session.tracks.length) {
      void audioResolver.resolve(session.tracks[nextIdx].videoId).catch(() => {});
    }

    // Spawn FFmpeg to stream track audio in standard 44.1kHz stereo MP3 frames with ultra-low delay
    const ffmpegArgs: string[] = ['-loglevel', 'error'];

    // If starting with a seek offset (e.g. user jumped to near end of song for testing)
    if (isFirstTrack && typeof initialSeekSeconds === 'number' && initialSeekSeconds > 0) {
      ffmpegArgs.push('-ss', String(Math.floor(initialSeekSeconds)));
    }
    isFirstTrack = false;

    ffmpegArgs.push(
      '-fflags', 'nobuffer',
      '-probesize', '32k',
      '-analyzeduration', '0',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', streamUrl,
      '-vn',
      '-ar', '44100',
      '-ac', '2',
      '-b:a', '192k',
      '-flush_packets', '1',
      '-f', 'mp3',
      'pipe:1'
    );

    try {
      await new Promise<void>((resolve) => {
        const proc = spawn(ffmpegPath!, ffmpegArgs, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        session.activeProcess = proc;

        proc.stdout?.on('data', (chunk: Buffer) => {
          if (!rawRes.destroyed && !rawRes.writableEnded) {
            rawRes.write(chunk);
          }
        });

        proc.stderr?.on('data', (errData: Buffer) => {
          request.log.warn({ ffmpegStderr: errData.toString().trim() }, 'Continuous ffmpeg stderr');
        });

        proc.on('error', (procErr) => {
          request.log.error({ err: procErr }, 'Continuous stream process error');
          resolve();
        });

        proc.on('close', () => {
          session.activeProcess = null;
          resolve();
        });
      });
    } catch (streamErr) {
      request.log.error({ err: streamErr }, 'Error during track streaming');
    }

    if (session.skipRequested) {
      session.skipRequested = false;
      if (typeof session.nextTrackIndex === 'number') {
        session.currentIndex = session.nextTrackIndex;
        session.nextTrackIndex = undefined;
      } else {
        session.currentIndex++;
      }
    } else if (session.repeatMode === 'one') {
      // Replay current track seamlessly over unbroken stream without advancing index
    } else {
      session.currentIndex++;
      if (session.repeatMode === 'all' && session.currentIndex >= session.tracks.length) {
        // Loop playlist/queue back to the beginning seamlessly!
        session.currentIndex = 0;
      }
    }
  }

  if (!rawRes.destroyed && !rawRes.writableEnded) {
    rawRes.end();
  }
  activeSessions.delete(sid);
}
