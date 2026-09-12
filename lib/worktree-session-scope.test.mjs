import assert from "node:assert/strict";
import test from "node:test";

import {
  isWorktreeSessionScopeEnabled,
  setWorktreeSessionScopeEnabled,
  WORKTREE_SESSION_SCOPE_EVENT,
} from "./worktree-session-scope.ts";

function installWindow() {
  const store = new Map();
  const listeners = new Set();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler),
    dispatchEvent: (event) => {
      for (const handler of listeners) handler(event);
      return true;
    },
  };
  return { listeners };
}

test("defaults to showing all worktrees when no preference is stored", () => {
  installWindow();
  assert.equal(isWorktreeSessionScopeEnabled(), false);
});

test("persists the preference and notifies listeners on change", () => {
  installWindow();
  let notified = 0;
  globalThis.window.addEventListener(WORKTREE_SESSION_SCOPE_EVENT, () => notified++);

  setWorktreeSessionScopeEnabled(true);
  assert.equal(isWorktreeSessionScopeEnabled(), true);
  assert.equal(notified, 1);

  setWorktreeSessionScopeEnabled(false);
  assert.equal(isWorktreeSessionScopeEnabled(), false);
  assert.equal(notified, 2);
});

test("returns false when window is unavailable (SSR)", () => {
  const original = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(isWorktreeSessionScopeEnabled(), false);
  } finally {
    if (original !== undefined) globalThis.window = original;
  }
});
