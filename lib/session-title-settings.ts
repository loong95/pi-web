import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { parseSessionTitleModelRef, type SessionTitleModelRef } from "./session-title-model";

export interface SessionTitleSettings {
  /** Experimental opt-in: name a session automatically after its first prompt. */
  autoEnabled: boolean;
  /** Title model. `null` follows the model the session itself is using. */
  model: SessionTitleModelRef | null;
}

export interface SessionTitleSettingsPatch {
  autoEnabled?: boolean;
  model?: SessionTitleModelRef | null;
}

type StoredSessionTitleSettings = Record<string, unknown> & {
  version?: unknown;
  autoEnabled?: unknown;
  model?: unknown;
};

export const DEFAULT_SESSION_TITLE_SETTINGS: SessionTitleSettings = {
  autoEnabled: false,
  model: null,
};

export function getSessionTitleSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "session-title.json");
}

function readStoredSettings(settingsPath: string): StoredSessionTitleSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid session title settings: expected an object");
  }
  return parsed as StoredSessionTitleSettings;
}

export function readSessionTitleSettings(
  settingsPath = getSessionTitleSettingsPath(),
): SessionTitleSettings {
  const stored = readStoredSettings(settingsPath);
  return {
    autoEnabled: stored.autoEnabled === true,
    model: parseSessionTitleModelRef(stored.model),
  };
}

/**
 * Read the settings on a background path such as automatic naming: an
 * unreadable file must disable the feature instead of failing the request.
 */
export function readSessionTitleSettingsSafely(
  settingsPath = getSessionTitleSettingsPath(),
): SessionTitleSettings {
  try {
    return readSessionTitleSettings(settingsPath);
  } catch {
    return { ...DEFAULT_SESSION_TITLE_SETTINGS };
  }
}

export function writeSessionTitleSettings(
  patch: SessionTitleSettingsPatch,
  settingsPath = getSessionTitleSettingsPath(),
): SessionTitleSettings {
  if (patch.autoEnabled !== undefined && typeof patch.autoEnabled !== "boolean") {
    throw new Error("autoEnabled must be a boolean");
  }
  if (patch.model !== undefined && patch.model !== null && parseSessionTitleModelRef(patch.model) === null) {
    throw new Error("model must be null or { provider, modelId }");
  }

  const stored = readStoredSettings(settingsPath);
  const next: Record<string, unknown> = { ...stored, version: 1 };
  if (patch.autoEnabled !== undefined) next.autoEnabled = patch.autoEnabled;
  if (patch.model !== undefined) {
    if (patch.model === null) {
      delete next.model;
    } else {
      next.model = {
        provider: patch.model.provider.trim(),
        modelId: patch.model.modelId.trim(),
      };
    }
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify(next, null, 2));
  return readSessionTitleSettings(settingsPath);
}
