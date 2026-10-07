"use client";

import { useCallback, useEffect, useState } from "react";

// The file explorer's server-side settings, read once per mount and cached in
// this module so the explorer's toolbar switch and Settings › Experimental
// share one answer without either owning it. The server holds the truth (the
// same file is read by /api/files and /api/file-index), so a write announces
// itself and every reader re-reads.

export interface FileBrowserPreferences {
  /** Project-relative patterns the `@` file index never lists. */
  searchExclude: string[];
}

export const DEFAULT_FILE_BROWSER_PREFERENCES: FileBrowserPreferences = {
  searchExclude: [],
};

export const FILE_BROWSER_SETTINGS_CHANGED_EVENT = "pi-web:file-browser-settings-changed";

/** Notify mounted readers that the stored preferences changed. */
export function announceFileBrowserSettingsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(FILE_BROWSER_SETTINGS_CHANGED_EVENT));
}

let cached: FileBrowserPreferences | null = null;
let inFlight: Promise<FileBrowserPreferences> | null = null;

/** Set when the last load failed, so a settings panel can say so instead of showing defaults as if they were stored. */
let lastLoadFailed = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePreferences(value: unknown): FileBrowserPreferences {
  if (!isRecord(value)) return { ...DEFAULT_FILE_BROWSER_PREFERENCES };
  return {
    searchExclude: Array.isArray(value.searchExclude)
      ? value.searchExclude.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

/** The stored preferences, or the defaults when the server cannot be asked. */
export function loadFileBrowserPreferences(): Promise<FileBrowserPreferences> {
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = fetch("/api/file-browser/settings", { cache: "no-store" })
    .then((response) => response.ok ? response.json() as Promise<unknown> : Promise.reject(new Error(`HTTP ${response.status}`)))
    .then((data) => {
      cached = parsePreferences(data);
      lastLoadFailed = false;
      return cached;
    })
    .catch(() => {
      lastLoadFailed = true;
      return { ...DEFAULT_FILE_BROWSER_PREFERENCES };
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Store `patch` and answer the settings as they are afterwards. */
export async function saveFileBrowserPreferences(
  patch: Partial<FileBrowserPreferences>,
): Promise<FileBrowserPreferences> {
  const response = await fetch("/api/file-browser/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await response.json().catch(() => ({})) as unknown;
  if (!response.ok) {
    const message = isRecord(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  cached = parsePreferences(data);
  announceFileBrowserSettingsChanged();
  return cached;
}

/** Test seam: forget the module cache. */
export function resetFileBrowserPreferencesCache(): void {
  cached = null;
  inFlight = null;
  lastLoadFailed = false;
}

/**
 * The preferences as React state: re-read whenever a write announces itself,
 * so the explorer switch and the settings panel never disagree.
 */
export function useFileBrowserPreferences(): {
  preferences: FileBrowserPreferences;
  loaded: boolean;
  /** True when the settings could not be read; the preferences shown are the defaults. */
  loadFailed: boolean;
  save: (patch: Partial<FileBrowserPreferences>) => Promise<FileBrowserPreferences>;
} {
  const [preferences, setPreferences] = useState<FileBrowserPreferences>(
    () => cached ?? { ...DEFAULT_FILE_BROWSER_PREFERENCES },
  );
  const [loaded, setLoaded] = useState(cached !== null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadFileBrowserPreferences().then((value) => {
      if (cancelled) return;
      setPreferences(value);
      setLoaded(true);
      setLoadFailed(lastLoadFailed);
    });
    const onChange = () => { void loadFileBrowserPreferences().then((value) => { if (!cancelled) setPreferences(value); }); };
    window.addEventListener(FILE_BROWSER_SETTINGS_CHANGED_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(FILE_BROWSER_SETTINGS_CHANGED_EVENT, onChange);
    };
  }, []);

  const save = useCallback(async (patch: Partial<FileBrowserPreferences>) => {
    const value = await saveFileBrowserPreferences(patch);
    setPreferences(value);
    setLoaded(true);
    setLoadFailed(false);
    return value;
  }, []);

  return { preferences, loaded, loadFailed, save };
}
