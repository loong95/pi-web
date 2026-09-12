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
  assert.match(source, /if \(currentWorktreePath === path\) setSelectedCwd\(worktreeState\.projectRoot\)/);
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});

test("scopes the session list to the current worktree behind the experimental preference", () => {
  assert.match(source, /currentWorktreeKey: string \| null/);
  assert.match(source, /currentWorktreeKey: d\.currentWorktreeKey \?\? null/);
  assert.match(source, /const worktreeScopeKey = worktreeSessionScope \? worktreeState\?\.currentWorktreeKey \?\? null : null/);
  assert.match(source, /filteredSessions\.filter\(\(session\) => session\.worktreeKey === worktreeScopeKey\)/);
  assert.match(source, /listSessionFamilies\(scopedSessions\)/);
  assert.match(source, /addEventListener\(WORKTREE_SESSION_SCOPE_EVENT, sync\)/);
});

test("shows per-worktree unread and running activity in the switcher", () => {
  assert.match(source, /key\?: string/);
  assert.match(source, /getWorktreeActivity\(allSessions, runningSessionIds, unreadSessionIds\)/);
  assert.match(source, /showProjectActivity\(wt\.key \? worktreeActivity\.get\(wt\.key\) : undefined, t\)/);
});
