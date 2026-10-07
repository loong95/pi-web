import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-browser-settings-")));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const {
  DEFAULT_FILE_BROWSER_SETTINGS,
  FILE_BROWSER_SETTINGS_MAX_BYTES,
  SEARCH_EXCLUDE_MAX_ENTRIES,
  SEARCH_EXCLUDE_MAX_LENGTH,
  readFileBrowserSettings,
  readFileBrowserSettingsSafely,
  writeFileBrowserSettings,
} = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./file-browser-settings.ts");

let count = 0;
function settingsPath() {
  return path.join(root, `settings-${++count}.json`);
}

test("defaults: the index excludes nothing", () => {
  assert.deepEqual(readFileBrowserSettings(settingsPath()), DEFAULT_FILE_BROWSER_SETTINGS);
  assert.deepEqual(DEFAULT_FILE_BROWSER_SETTINGS, { searchExclude: [] });
});

test("the pattern list round-trips", () => {
  const file = settingsPath();
  writeFileBrowserSettings({ searchExclude: ["node_modules", "deps/libA"] }, file);
  assert.deepEqual(readFileBrowserSettings(file), { searchExclude: ["node_modules", "deps/libA"] });
});

test("patterns are trimmed, deduplicated and dropped when blank", () => {
  const file = settingsPath();
  writeFileBrowserSettings({ searchExclude: ["  deps/libA  ", "deps/libA", "", "   ", "build/"] }, file);
  assert.deepEqual(readFileBrowserSettings(file).searchExclude, ["deps/libA", "build/"]);
});

test("an empty list removes the key instead of storing an empty array", () => {
  const file = settingsPath();
  writeFileBrowserSettings({ searchExclude: ["node_modules"] }, file);
  writeFileBrowserSettings({ searchExclude: [] }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { version: 1 });
  assert.deepEqual(readFileBrowserSettings(file), { searchExclude: [] });
});

test("an unrelated key in the file survives a write", () => {
  const file = settingsPath();
  fs.writeFileSync(file, JSON.stringify({ version: 1, future: { keep: true } }));
  writeFileBrowserSettings({ searchExclude: ["vendor"] }, file);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(stored.future, { keep: true });
  assert.deepEqual(stored.searchExclude, ["vendor"]);
});

test("the file is written with private permissions", () => {
  const file = settingsPath();
  writeFileBrowserSettings({ searchExclude: ["vendor"] }, file);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("a stored value of the wrong shape reads as an empty list", () => {
  const file = settingsPath();
  fs.writeFileSync(file, JSON.stringify({ version: 1, searchExclude: ["ok", 7, null, ""] }));
  assert.deepEqual(readFileBrowserSettings(file), { searchExclude: ["ok"] });
  fs.writeFileSync(file, JSON.stringify({ searchExclude: "node_modules" }));
  assert.deepEqual(readFileBrowserSettings(file), { searchExclude: [] });
});

test("a file that is not an object is refused, and reads as defaults on the safe path", () => {
  const file = settingsPath();
  fs.writeFileSync(file, "[1,2,3]");
  assert.throws(() => readFileBrowserSettings(file), /expected an object/);
  assert.deepEqual(readFileBrowserSettingsSafely(file), { searchExclude: [] });
});

test("unparsable JSON reads as defaults on the safe path", () => {
  const file = settingsPath();
  fs.writeFileSync(file, "{not json");
  assert.throws(() => readFileBrowserSettings(file));
  assert.deepEqual(readFileBrowserSettingsSafely(file), { searchExclude: [] });
});

test("a missing file is defaults, not an error", () => {
  assert.deepEqual(readFileBrowserSettingsSafely(path.join(root, "absent.json")), { searchExclude: [] });
});

test("a FIFO is refused instead of stalling the listing", { skip: process.platform === "win32" }, () => {
  // `/api/file-index` reads this file on every listing; a plain readFileSync
  // would wait for a writer forever.
  const fifo = path.join(root, "fifo-settings.json");
  execFileSync("mkfifo", [fifo]);
  const started = Date.now();
  assert.deepEqual(readFileBrowserSettingsSafely(fifo), { searchExclude: [] });
  assert.ok(Date.now() - started < 1000, "the read must not wait");
  assert.throws(() => readFileBrowserSettings(fifo), /not a regular file/);
});

test("a file past the size cap is refused rather than parsed", () => {
  const file = settingsPath();
  fs.writeFileSync(file, JSON.stringify({ searchExclude: ["x".repeat(FILE_BROWSER_SETTINGS_MAX_BYTES)] }));
  assert.deepEqual(readFileBrowserSettingsSafely(file), { searchExclude: [] });
  assert.throws(() => readFileBrowserSettings(file), /larger than/);
});

test("a value of the wrong type is refused before anything is written", () => {
  const file = settingsPath();
  assert.throws(() => writeFileBrowserSettings({ searchExclude: "node_modules" }, file), /must be an array/);
  assert.throws(() => writeFileBrowserSettings({ searchExclude: ["ok", 7] }, file), /must be an array of strings/);
  assert.equal(fs.existsSync(file), false);
});

test("the list and each pattern are bounded", () => {
  const file = settingsPath();
  const tooMany = Array.from({ length: SEARCH_EXCLUDE_MAX_ENTRIES + 1 }, (_, index) => `dir${index}`);
  assert.throws(() => writeFileBrowserSettings({ searchExclude: tooMany }, file), /at most 200 entries/);
  assert.throws(
    () => writeFileBrowserSettings({ searchExclude: ["x".repeat(SEARCH_EXCLUDE_MAX_LENGTH + 1)] }, file),
    /at most 400 characters/,
  );
  // A long pattern stored by hand is dropped by a read rather than kept.
  fs.writeFileSync(file, JSON.stringify({ searchExclude: ["ok", "y".repeat(SEARCH_EXCLUDE_MAX_LENGTH + 1)] }));
  assert.deepEqual(readFileBrowserSettings(file).searchExclude, ["ok"]);
});

test("a stored list longer than the cap is truncated by a read", () => {
  const file = settingsPath();
  const stored = Array.from({ length: SEARCH_EXCLUDE_MAX_ENTRIES + 20 }, (_, index) => `dir${index}`);
  fs.writeFileSync(file, JSON.stringify({ searchExclude: stored }));
  assert.equal(readFileBrowserSettings(file).searchExclude.length, SEARCH_EXCLUDE_MAX_ENTRIES);
});
