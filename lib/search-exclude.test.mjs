import assert from "node:assert/strict";
import test from "node:test";

const {
  compileExclusionPattern,
  compileExclusionPatterns,
  isExcludedPath,
} = await import("./search-exclude.ts");

function excluded(path, patterns, isDirectory = false) {
  return isExcludedPath(path, compileExclusionPatterns(patterns), isDirectory);
}

test("an unanchored name matches at any depth, as a .gitignore line does", () => {
  assert.equal(excluded("node_modules/pkg/index.js", ["node_modules"]), true);
  assert.equal(excluded("a/b/node_modules/pkg/index.js", ["node_modules"]), true);
  assert.equal(excluded("node_modules_extra/index.js", ["node_modules"]), false);
  assert.equal(excluded("my_node_modules/index.js", ["node_modules"]), false);
});

test("a pattern holding a slash is anchored to the project root", () => {
  assert.equal(excluded("deps/libA/a.ts", ["deps/libA"]), true);
  assert.equal(excluded("other/deps/libA/a.ts", ["deps/libA"]), false);
  // A leading slash anchors without becoming part of the path.
  assert.equal(excluded("deps/libA/a.ts", ["/deps/libA"]), true);
});

test("a trailing slash matches directories only", () => {
  assert.equal(excluded("dist", ["dist/"], true), true);
  assert.equal(excluded("dist", ["dist/"], false), false);
  // Everything below a matched directory is excluded either way.
  assert.equal(excluded("dist/bundle.js", ["dist/"]), true);
});

test("an excluded directory hides its contents", () => {
  assert.equal(excluded("deps/libA/src/deep/file.ts", ["deps/libA"]), true);
  assert.equal(excluded("build/x/y/z.js", ["build/**"]), true);
});

test("* stops at a slash while ** crosses it", () => {
  assert.equal(excluded("build/main.js", ["*/main.js"]), true);
  assert.equal(excluded("build/nested/main.js", ["*/main.js"]), false);
  assert.equal(excluded("build/nested/main.js", ["**/main.js"]), true);
  // `build/*` matches the directory `build/nested`, and an ignored directory
  // hides everything below it, exactly as `git check-ignore` reports it.
  assert.equal(excluded("build/nested/main.js", ["build/*"]), true);
  assert.equal(excluded("build/nested/main.js", ["build/**"]), true);
});

test("? matches one character that is not a slash", () => {
  assert.equal(excluded("pkg1/index.js", ["pkg?"]), true);
  assert.equal(excluded("pkg12/index.js", ["pkg?"]), false);
});

test("a character class matches one of its characters", () => {
  assert.equal(excluded("pkgA/index.js", ["pkg[AB]"]), true);
  assert.equal(excluded("pkgC/index.js", ["pkg[AB]"]), false);
  // An unterminated class is a literal bracket, not a broken regex.
  assert.equal(excluded("pkg[", ["pkg["]), true);
  assert.equal(excluded("pkgA", ["pkg[AB"]), false);
});

test("a negation is refused: the list only ever adds exclusions", () => {
  assert.equal(compileExclusionPattern("!deps/libA"), null);
  assert.equal(excluded("deps/libA/a.ts", ["!deps/libA"]), false);
});

test("blank and root-only patterns compile to nothing", () => {
  assert.equal(compileExclusionPattern("   "), null);
  assert.equal(compileExclusionPattern("/"), null);
  assert.equal(compileExclusionPattern("./"), null);
  assert.deepEqual(compileExclusionPatterns(["", "  ", "!x"]).sources, []);
});

test("./ and backslash separators read as the project root", () => {
  assert.equal(excluded("./deps/libA/a.ts", ["./deps/libA"]), true);
  assert.equal(excluded("deps\\libA\\a.ts", ["deps/libA"]), true);
});

test("no patterns exclude nothing", () => {
  assert.equal(excluded("node_modules/pkg/index.js", []), false);
  assert.equal(isExcludedPath("a/b", compileExclusionPatterns([]), false), false);
  assert.equal(isExcludedPath("", compileExclusionPatterns(["a"]), false), false);
});

test("a list of bare names is matched without a regex each", () => {
  // The index tests every file against the list, so 200 bare names must not
  // cost 200 regexes per path: they land in Sets and are classified once.
  const compiled = compileExclusionPatterns(["node_modules", ".next", "dist", "build/"]);
  assert.deepEqual([...compiled.names].sort(), [".next", "dist", "node_modules"]);
  assert.deepEqual([...compiled.directoryNames], ["build"]);
  assert.equal(compiled.nameGlobs.matches, null);
  assert.equal(compiled.nameGlobs.directoryMatch, null);
  assert.equal(compiled.paths.size, 0);
});

test("only a pattern with a glob character or a slash compiles a regex", () => {
  const compiled = compileExclusionPatterns(["pkg[AB]", "*.log", "deps/libA", "build/**"]);
  // Both bare globs share one alternation, so their count does not matter.
  assert.match(compiled.nameGlobs.matches.source, /pkg\[AB\]/);
  assert.match(compiled.nameGlobs.matches.source, /\[\^\/\]\*\\\.log/);
  // `build/**` starts with a literal segment, so it too is filed in a bucket;
  // only a pattern whose first segment is a glob needs the wildcard list.
  assert.deepEqual([...compiled.paths.keys()].sort(), ["build", "deps"]);
  assert.equal(compiled.wildcardPaths.matches, null);
  assert.deepEqual([...compiled.names], []);
});

test("a directory-only name reaches a file below it but not a file of that name", () => {
  const patterns = compileExclusionPatterns(["dist/"]);
  assert.equal(isExcludedPath("dist", patterns, true), true);
  assert.equal(isExcludedPath("dist", patterns, false), false);
  assert.equal(isExcludedPath("dist/bundle.js", patterns, false), true);
  assert.equal(isExcludedPath("a/dist/bundle.js", patterns, false), true);
});

test("a path pattern is filed under its first segment", () => {
  // A path only consults the patterns that could name it, so 200 path patterns
  // do not cost 200 regexes per file.
  const compiled = compileExclusionPatterns(["deps/libA", "src/gen/**", "**/cache"]);
  assert.deepEqual([...compiled.paths.keys()].sort(), ["deps", "src"]);
  // The leading double-star segment is optional, so a top-level `cache` counts.
  assert.equal(compiled.wildcardPaths.matches.test("cache"), true);
  assert.equal(compiled.wildcardPaths.matches.test("a/b/cache"), true);
  assert.equal(isExcludedPath("deps/libA/a.ts", compiled, false), true);
  assert.equal(isExcludedPath("src/gen/out.js", compiled, false), true);
  assert.equal(isExcludedPath("a/b/cache", compiled, false), true);
  assert.equal(isExcludedPath("other/deps/libA/a.ts", compiled, false), false);
});

test("every pattern shape is still excluded after the split by kind", () => {
  // One of each kind in a single list, so the fast paths cannot disagree with
  // each other about the same path.
  const patterns = compileExclusionPatterns(["node_modules", "build/", "*.log", "deps/libA"]);
  for (const path of ["node_modules/pkg/index.js", "build/out.js", "debug.log", "deps/libA/a.ts", "a/node_modules/x.js"]) {
    assert.equal(isExcludedPath(path, patterns, false), true, path);
  }
  for (const path of ["src/main.ts", "node_modules_extra/x.js", "release.logger", "other/deps/libA/x.ts"]) {
    assert.equal(isExcludedPath(path, patterns, false), false, path);
  }
});
