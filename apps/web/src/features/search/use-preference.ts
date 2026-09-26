"use client";

// ============================================
// DENGARKAN — Search Feature: Preference Hook
//
// Drives the "YouTube-like" home feed when the search bar is empty.
// Priority: last played track (related / Mix) → chosen interest keyword → onboarding.
// Read-only consumer of the player context — never touches the audio engine.
// ============================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResult } from "@dengarkan/shared";
import { apiClient } from "@/services/api-client";
import { usePlayer } from "@/features/player/context";

const PREF_STORAGE_KEY = "dengarkan_preference";

export interface Preference {
  type: "keyword" | "track";
  value: string; // keyword or videoId
  label: string; // display label
  updatedAt: number;
}

function readPref(): Preference | null {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && (p.type === "keyword" || p.type === "track") && typeof p.value === "string") return p;
  } catch {
    // ignore
  }
  return null;
}

function writePref(p: Preference | null) {
  try {
    if (p) localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(p));
    else localStorage.removeItem(PREF_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function usePreference() {
  const { historyList } = usePlayer();
  const [preference, setPreference] = useState<Preference | null>(null);
  const [preferenceResults, setPreferenceResults] = useState<SearchResult[]>([]);
  const [isPrefLoading, setIsPrefLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    setPreference(readPref());
    setLoaded(true);
  }, []);

  // Every played track becomes the newest preference.
  const lastPlayed = historyList[0];
  useEffect(() => {
    if (!loaded || !lastPlayed?.videoId) return;
    setPreference((prev) => {
      if (prev?.type === "track" && prev.value === lastPlayed.videoId) return prev;
      const next: Preference = {
        type: "track",
        value: lastPlayed.videoId,
        label: `${lastPlayed.title} — ${lastPlayed.channelName}`,
        updatedAt: Date.now(),
      };
      writePref(next);
      return next;
    });
  }, [loaded, lastPlayed?.videoId, lastPlayed?.title, lastPlayed?.channelName]);

  // Fetch feed whenever preference changes.
  useEffect(() => {
    if (!preference) {
      setPreferenceResults([]);
      return;
    }
    const id = ++reqRef.current;
    setIsPrefLoading(true);
    const p =
      preference.type === "track"
        ? apiClient.youtube.related(preference.value, preference.label.slice(0, 100))
        : apiClient.youtube.search(preference.value);
    p.then((res) => {
      if (reqRef.current === id) setPreferenceResults(res.results ?? []);
    })
      .catch(() => {
        if (reqRef.current === id) setPreferenceResults([]);
      })
      .finally(() => {
        if (reqRef.current === id) setIsPrefLoading(false);
      });
  }, [preference]);

  const chooseInterest = useCallback((keyword: string) => {
    const next: Preference = { type: "keyword", value: keyword, label: keyword, updatedAt: Date.now() };
    writePref(next);
    setPreference(next);
  }, []);

  const resetPreference = useCallback(() => {
    writePref(null);
    setPreference(null);
  }, []);

  return { preference, preferenceResults, isPrefLoading, loaded, chooseInterest, resetPreference };
}
