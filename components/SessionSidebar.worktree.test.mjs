import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("uses the server-resolved current worktree identity", () => {
  assert.match(source, /currentWorktreePath: string \| null/);
  assert.match(
    source,
    /const currentWorktree =[\s\S]*?worktreeState\.currentWorktreePath[\s\S]*?worktree\.path === worktreeState\.currentWorktreePath/,
  );
  assert.match(source, /if \(currentWorktreePath === path\) setSelectedCwd\(project\.root\);/);
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});

test("scopes the session list to the current worktree behind the experimental preference", () => {
  assert.match(source, /currentWorktreeKey: string \| null/);
  assert.match(source, /currentWorktreeKey: d\.currentWorktreeKey \?\? null/);
  assert.match(source, /const worktreeScopeKey = worktreeSessionScope \? worktreeState\?\.currentWorktreeKey \?\? null : null/);
  assert.match(source, /allSessions\.filter\(\(session\) => session\.worktreeKey === worktreeScopeKey\)/);
  // The tree, its families and the archive all read the scoped set, so the
  // preference cannot hide a row in one place and show it in another.
  assert.match(source, /listSessionFamilies\(visibleSessions\)/);
  assert.match(source, /sessions: visibleSessions,/);
  assert.match(source, /addEventListener\(WORKTREE_SESSION_SCOPE_EVENT, sync\)/);
});
