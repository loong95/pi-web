/**
 * Experimental sidebar preference: scope the session list to the current
 * worktree instead of showing every worktree of the project together.
 *
 * Stored in localStorage; best-effort (silently ignored when unavailable).
 * A change broadcasts an event so an already-mounted sidebar updates without
 * a reload.
 */

const STORAGE_KEY = "pi-web:worktree-session-scope";

export const WORKTREE_SESSION_SCOPE_EVENT = "pi-web-worktree-session-scope-changed";

export function isWorktreeSessionScopeEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function setWorktreeSessionScopeEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Persistence is best-effort.
  }
  window.dispatchEvent(new Event(WORKTREE_SESSION_SCOPE_EVENT));
}
