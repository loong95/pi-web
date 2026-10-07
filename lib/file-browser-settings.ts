import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { readRegularFileText } from "./regular-file";

// ============================================================================
// `searchExclude`: what the @ file index leaves out.
//
// The index follows Git (`git ls-files --cached --others --exclude-standard`),
// which is the right default but leaves no way to say "keep this one out" for
// a tree Git does track: a vendored dependency, a generated client, a fixture
// dump. Those pollute completions at every keystroke, and the list below is
// the answer.
//
// The file browser's other preference, whether the tree lists what Git
// ignores, belongs to the explorer's own switch (upstream #1092, kept per
// browser in `lib/sidebar-prefs.ts`), so it is not here.
//
// The file lives in the agent directory, like `session-title.json` and
// `plantuml.json`, so every browser and device sees one answer.
// ============================================================================

export interface FileBrowserSettings {
  /** Project-relative patterns the `@` file index never lists. */
  searchExclude: string[];
}

export type FileBrowserSettingsPatch = Partial<FileBrowserSettings>;

export const DEFAULT_FILE_BROWSER_SETTINGS: FileBrowserSettings = {
  searchExclude: [],
};

/** Bounds a pattern list a client sends, so one request cannot grow the file without limit. */
export const SEARCH_EXCLUDE_MAX_ENTRIES = 200;
export const SEARCH_EXCLUDE_MAX_LENGTH = 400;

/** A settings file anywhere near this size is not one. */
export const FILE_BROWSER_SETTINGS_MAX_BYTES = 64 * 1024;

type StoredFileBrowserSettings = Record<string, unknown> & {
  version?: unknown;
  searchExclude?: unknown;
};

export function getFileBrowserSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "file-browser.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStoredSettings(settingsPath: string): StoredFileBrowserSettings {
  // `/api/file-index` reads this on every listing, so the read must never wait
  // on a FIFO or a device: `readRegularFileText()` opens without blocking and
  // refuses anything that is not a regular file of a sane size.
  const text = readRegularFileText(settingsPath, FILE_BROWSER_SETTINGS_MAX_BYTES);
  if (text === undefined) return {};
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("Invalid file browser settings: expected an object");
  return parsed as StoredFileBrowserSettings;
}

/** One stored pattern, or null when it is not a usable one. */
function normalizePattern(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SEARCH_EXCLUDE_MAX_LENGTH) return null;
  return trimmed;
}

function readPatterns(stored: unknown): string[] {
  if (!Array.isArray(stored)) return [];
  const patterns: string[] = [];
  for (const entry of stored.slice(0, SEARCH_EXCLUDE_MAX_ENTRIES)) {
    const pattern = normalizePattern(entry);
    if (pattern && !patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

export function readFileBrowserSettings(
  settingsPath = getFileBrowserSettingsPath(),
): FileBrowserSettings {
  return { searchExclude: readPatterns(readStoredSettings(settingsPath).searchExclude) };
}

/**
 * The settings on a background path such as a file listing: an unreadable file
 * must give the defaults instead of failing the request.
 */
export function readFileBrowserSettingsSafely(
  settingsPath = getFileBrowserSettingsPath(),
): FileBrowserSettings {
  try {
    return readFileBrowserSettings(settingsPath);
  } catch {
    return { searchExclude: [] };
  }
}

export function writeFileBrowserSettings(
  patch: FileBrowserSettingsPatch,
  settingsPath = getFileBrowserSettingsPath(),
): FileBrowserSettings {
  if (patch.searchExclude !== undefined) {
    if (!Array.isArray(patch.searchExclude)) throw new Error("searchExclude must be an array of strings");
    if (patch.searchExclude.length > SEARCH_EXCLUDE_MAX_ENTRIES) {
      throw new Error(`searchExclude holds at most ${SEARCH_EXCLUDE_MAX_ENTRIES} entries`);
    }
    if (patch.searchExclude.some((entry) => typeof entry !== "string")) {
      throw new Error("searchExclude must be an array of strings");
    }
    if (patch.searchExclude.some((entry) => entry.trim().length > SEARCH_EXCLUDE_MAX_LENGTH)) {
      throw new Error(`a searchExclude pattern holds at most ${SEARCH_EXCLUDE_MAX_LENGTH} characters`);
    }
  }

  const stored = readStoredSettings(settingsPath);
  const next: Record<string, unknown> = { ...stored, version: 1 };
  if (patch.searchExclude !== undefined) {
    const patterns = readPatterns(patch.searchExclude);
    if (patterns.length > 0) next.searchExclude = patterns;
    else delete next.searchExclude;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(next, null, 2));
  return readFileBrowserSettings(settingsPath);
}
