// ============================================
// DENGARKAN — YouTube Search Service
// ============================================

import type { SearchResponse, SearchResult } from '@dengarkan/shared';
import ytSearch from 'yt-search';

function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export async function searchTracks(query: string): Promise<SearchResponse> {
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    return { query: cleanQuery, results: [] };
  }

  const result = await ytSearch(cleanQuery);
  const videos = (result.videos || []).slice(0, 25);

  const results: SearchResult[] = videos.map((v) => ({
    videoId: v.videoId,
    title: v.title,
    channelName: v.author?.name || 'Unknown Channel',
    thumbnailUrl: v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    durationSeconds: v.seconds || 0,
    durationFormatted: v.timestamp || formatSeconds(v.seconds || 0),
  }));

  return {
    query: cleanQuery,
    results,
  };
}
