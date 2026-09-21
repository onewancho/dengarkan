// ============================================
// DENGARKAN — Audio Module: Robust FFmpeg Helper
//
// Finds, verifies, and ensures execute permissions for FFmpeg across all
// server environments (Linux VPS, Docker, macOS, PM2).
//
// Resolution Priority:
//   1. FFMPEG_PATH or FFMPEG_BIN environment variable
//   2. ffmpeg-static package (with auto-chmod 0755 & on-demand download if skipped by pnpm)
//   3. System ffmpeg binary ('ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg')
// ============================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import ffmpegStaticPath from 'ffmpeg-static';

const require = createRequire(import.meta.url);

let cachedWorkingFfmpeg: string | null = null;
let lastFfmpegError: string | null = null;

function testFfmpegExecutable(binPath: string): boolean {
  try {
    const res = spawnSync(binPath, ['-version'], {
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) {
      lastFfmpegError = res.error.message;
      return false;
    }
    return res.status === 0;
  } catch (e) {
    lastFfmpegError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

function ensureExecutable(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    try {
      fs.chmodSync(filePath, 0o755);
    } catch {
      // Non-fatal if read-only or not owner
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the path to a verified, working FFmpeg binary on the system.
 * Throws an informative Error if no working FFmpeg binary is found.
 */
export function getFfmpegPath(): string {
  if (cachedWorkingFfmpeg && testFfmpegExecutable(cachedWorkingFfmpeg)) {
    return cachedWorkingFfmpeg;
  }

  // 1. Check FFMPEG_PATH or FFMPEG_BIN env var
  const envPath = process.env.FFMPEG_PATH || process.env.FFMPEG_BIN;
  if (envPath && envPath.trim()) {
    const trimmed = envPath.trim();
    ensureExecutable(trimmed);
    if (testFfmpegExecutable(trimmed)) {
      cachedWorkingFfmpeg = trimmed;
      return cachedWorkingFfmpeg;
    }
  }

  // 2. Check system ffmpeg binaries and `which ffmpeg` (fastest & preferred on Linux VPS / Ubuntu)
  const candidates = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
    '/bin/ffmpeg',
    '/snap/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/usr/pkg/bin/ffmpeg',
  ];

  for (const candidate of candidates) {
    if (testFfmpegExecutable(candidate)) {
      cachedWorkingFfmpeg = candidate;
      return cachedWorkingFfmpeg;
    }
  }

  try {
    const whichRes = spawnSync('which', ['ffmpeg'], { encoding: 'utf8', timeout: 2000 });
    if (whichRes.status === 0 && whichRes.stdout) {
      const p = whichRes.stdout.trim();
      if (p && testFfmpegExecutable(p)) {
        cachedWorkingFfmpeg = p;
        return cachedWorkingFfmpeg;
      }
    }
  } catch {
    // ignore
  }

  // 3. Fallback to bundled ffmpeg-static package
  if (ffmpegStaticPath && typeof ffmpegStaticPath === 'string') {
    if (fs.existsSync(ffmpegStaticPath)) {
      ensureExecutable(ffmpegStaticPath);
      if (testFfmpegExecutable(ffmpegStaticPath)) {
        cachedWorkingFfmpeg = ffmpegStaticPath;
        return cachedWorkingFfmpeg;
      }
    } else {
      // Binary missing from disk (e.g. pnpm skipped install scripts).
      // Attempt running install.js on-demand once.
      try {
        const installScript = require.resolve('ffmpeg-static/install.js');
        if (fs.existsSync(installScript)) {
          spawnSync(process.execPath, [installScript], {
            timeout: 60000,
            stdio: 'ignore',
          });
          if (fs.existsSync(ffmpegStaticPath)) {
            ensureExecutable(ffmpegStaticPath);
            if (testFfmpegExecutable(ffmpegStaticPath)) {
              cachedWorkingFfmpeg = ffmpegStaticPath;
              return cachedWorkingFfmpeg;
            }
          }
        }
      } catch {
        // Fallback to error below
      }
    }
  }

  const detail = lastFfmpegError ? ` (Last error: ${lastFfmpegError})` : '';
  throw new Error(
    `FFmpeg executable not found or not functional on this server${detail}. ` +
    'Please install ffmpeg (e.g. `sudo apt update && sudo apt install -y ffmpeg`), ' +
    'or set FFMPEG_PATH in your .env.'
  );
}

/**
 * Returns true if a working FFmpeg binary is present and executable.
 */
export function isFfmpegAvailable(): boolean {
  try {
    return Boolean(getFfmpegPath());
  } catch {
    return false;
  }
}
