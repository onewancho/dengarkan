// ============================================
// DENGARKAN — YouTube Module: Service
// ============================================

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import type { SearchResponse, SearchResult } from '@dengarkan/shared';
import ytSearch from 'yt-search';

const execFileAsync = promisify(execFile);

function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── In-Memory Search Cache (10 min TTL, max 100 queries) ──────────────────────
interface CacheEntry {
  response: SearchResponse;
  expiresAt: number;
}
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

function getCachedSearch(query: string): SearchResponse | null {
  const entry = searchCache.get(query);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(query);
    return null;
  }
  return entry.response;
}

function setCachedSearch(query: string, response: SearchResponse): void {
  if (searchCache.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest entry
    const oldestKey = searchCache.keys().next().value;
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(query, {
    response,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ── Search with yt-dlp (Fallback & High-Reliability Scraper) ──────────────────
async function searchWithYtDlp(query: string, limit = 20): Promise<SearchResult[]> {
  const ytdlpPath = process.env.YT_DLP_PATH || process.env.YTDLP_PATH || 'yt-dlp';
  const args = [
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
    '--socket-timeout', '10',
  ];

  const configuredCookies = process.env.YT_DLP_COOKIES_PATH || process.env.YTDLP_COOKIES_PATH;
  const candidates = [
    configuredCookies,
    pathResolve(process.cwd(), 'cookies.txt'),
    pathResolve(process.cwd(), '../../cookies.txt'),
  ].filter((p): p is string => Boolean(p && existsSync(p)));

  const cookiesBrowser =
    process.env.YT_DLP_COOKIES_FROM_BROWSER ||
    process.env.YTDLP_COOKIES_FROM_BROWSER;

  if (candidates.length > 0) {
    args.push('--cookies', candidates[0]);
  } else if (cookiesBrowser) {
    args.push('--cookies-from-browser', cookiesBrowser);
  }

  args.push(`ytsearch${limit}:${query}`);

  const { stdout } = await execFileAsync(ytdlpPath, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15000,
  });

  const data = JSON.parse(stdout);
  const entries: any[] = Array.isArray(data.entries) ? data.entries : [];

  return entries
    .filter((e) => e && typeof e.id === 'string' && e.id.length === 11)
    .map((e) => ({
      videoId: e.id,
      title: typeof e.title === 'string' ? e.title : 'Unknown Title',
      channelName:
        typeof e.channel === 'string'
          ? e.channel
          : typeof e.uploader === 'string'
          ? e.uploader
          : 'Unknown Channel',
      thumbnailUrl:
        Array.isArray(e.thumbnails) && e.thumbnails.length > 0
          ? e.thumbnails[e.thumbnails.length - 1].url
          : `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      durationSeconds: typeof e.duration === 'number' ? e.duration : 0,
      durationFormatted:
        typeof e.duration === 'number' && e.duration > 0
          ? formatSeconds(e.duration)
          : '0:00',
    }));
}

// ── Search with ytSearch (Fast In-Process Scraper with Error Guard) ───────────
async function searchWithYtSearch(query: string): Promise<SearchResult[]> {
  const result = await ytSearch({ query, pageStart: 1, pageEnd: 1 });
  const videos = (result.videos || []).slice(0, 25);

  return videos
    .filter((v) => v && typeof v.videoId === 'string')
    .map((v) => ({
      videoId: v.videoId,
      title: typeof v.title === 'string' ? v.title : 'Unknown Title',
      channelName: v.author?.name || 'Unknown Channel',
      thumbnailUrl:
        v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      durationSeconds: v.seconds || 0,
      durationFormatted: v.timestamp || formatSeconds(v.seconds || 0),
    }));
}

// ── Primary Search Tracks Entry Point ─────────────────────────────────────────
export async function searchTracks(query: string): Promise<SearchResponse> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return { query: cleanQuery, results: [] };

  const cacheKey = cleanQuery.toLowerCase();
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return cached;
  }

  let results: SearchResult[] = [];

  // Attempt 1: Fast in-process yt-search (with 4s timeout)
  try {
    const ytSearchPromise = searchWithYtSearch(cleanQuery);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('yt-search timeout')), 4000)
    );
    results = await Promise.race([ytSearchPromise, timeoutPromise]);
  } catch (err: any) {
    // yt-search failed (e.g. TypeError: title.trim is not a function or timeout)
    // Seamlessly fallback to yt-dlp
    results = [];
  }

  // Attempt 2: Fallback to yt-dlp if yt-search returned empty or errored
  if (results.length === 0) {
    try {
      results = await searchWithYtDlp(cleanQuery, 20);
    } catch (fallbackErr: any) {
      // Both scrapers failed, return empty or throw if absolutely necessary
      results = [];
    }
  }

  const response: SearchResponse = { query: cleanQuery, results };

  if (results.length > 0) {
    setCachedSearch(cacheKey, response);
  }

  return response;
}

// ── Related / "Up Next" via YouTube Mix playlist (RD<videoId>) ────────────────
const relatedCache = new Map<string, CacheEntry>();
const RELATED_TTL_MS = 30 * 60 * 1000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

async function relatedWithYtDlp(videoId: string, limit = 25): Promise<SearchResult[]> {
  const ytdlpPath = process.env.YT_DLP_PATH || process.env.YTDLP_PATH || 'yt-dlp';
  const args = [
    '--dump-single-json',
    '--flat-playlist',
    '--no-warnings',
    '--socket-timeout', '10',
    '--playlist-end', String(limit + 1),
  ];
  const configuredCookies = process.env.YT_DLP_COOKIES_PATH || process.env.YTDLP_COOKIES_PATH;
  const candidates = [
    configuredCookies,
    pathResolve(process.cwd(), 'cookies.txt'),
    pathResolve(process.cwd(), '../../cookies.txt'),
  ].filter((p): p is string => Boolean(p && existsSync(p)));
  if (candidates.length > 0) args.push('--cookies', candidates[0]);

  args.push(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`);

  const { stdout } = await execFileAsync(ytdlpPath, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 15000,
  });
  const data = JSON.parse(stdout);
  const entries: any[] = Array.isArray(data.entries) ? data.entries : [];
  return entries
    .filter((e) => e && typeof e.id === 'string' && VIDEO_ID_RE.test(e.id))
    .map((e) => ({
      videoId: e.id,
      title: typeof e.title === 'string' ? e.title : 'Unknown Title',
      channelName:
        typeof e.channel === 'string'
          ? e.channel
          : typeof e.uploader === 'string'
          ? e.uploader
          : 'Unknown Channel',
      thumbnailUrl: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
      durationSeconds: typeof e.duration === 'number' ? e.duration : 0,
      durationFormatted:
        typeof e.duration === 'number' && e.duration > 0 ? formatSeconds(e.duration) : '0:00',
    }));
}

export async function relatedTracks(videoId: string, hint?: string): Promise<SearchResponse> {
  if (!VIDEO_ID_RE.test(videoId)) return { query: videoId, results: [] };

  const cached = relatedCache.get(videoId);
  if (cached && Date.now() < cached.expiresAt) return cached.response;

  let results: SearchResult[] = [];
  try {
    results = await relatedWithYtDlp(videoId);
  } catch {
    results = [];
  }

  if (results.length === 0 && hint && hint.trim()) {
    try {
      results = (await searchTracks(`${hint.trim().slice(0, 100)} mix`)).results;
    } catch {
      results = [];
    }
  }

  results = results.filter((r) => r.videoId !== videoId);
  const response: SearchResponse = { query: videoId, results };

  if (results.length > 0) {
    if (relatedCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = relatedCache.keys().next().value;
      if (oldestKey) relatedCache.delete(oldestKey);
    }
    relatedCache.set(videoId, { response, expiresAt: Date.now() + RELATED_TTL_MS });
  }
  return response;
}

// ── Onboarding interests (trending + genres) ──────────────────────────────────
export const TRENDING_INTERESTS = {
  trending: [
    'Lagu Viral TikTok Terbaru',
    'Top Hits Indonesia 2026',
    'Lagu Galau Terpopuler',
    'Trending Music Global',
  ],
  genres: ['Pop Indonesia', 'Rock', 'Dangdut', 'K-Pop', 'Jazz', 'Lo-fi', 'Hip-Hop', 'Indie', 'EDM'],
};

