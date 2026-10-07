// ============================================================================
// Matching a `searchExclude` pattern against a project-relative path.
//
// The semantics are Git's, not minimatch's, because the list exists to say
// "leave this path out of the @ index" beside a `.gitignore`:
//
// - a pattern without a `/` matches that name at any depth (`node_modules`
//   covers `a/b/node_modules`), exactly as a gitignore line does,
// - a pattern with a `/` is anchored to the project root (`deps/libA`),
// - a trailing `/` restricts it to directories,
// - `*` stops at `/`, `**` crosses it, `?` matches one character that is not
//   `/`, and `[...]` is a character class,
// - a leading `**/` also matches at the root, so `**/cache` covers `cache`,
// - a leading `!` is refused: the list only ever adds exclusions.
//
// Pure and dependency-free: the route runs it on every listing, and the
// matcher must be testable without a repository.
//
// Matching cost must not follow the number of patterns. `/api/file-index`
// tests every one of a repository's files against this, so 200 patterns must
// not mean 200 regexes per path, nor one regex per path segment per pattern.
// `compileExclusionPatterns()` sorts the list by shape — bare literal names
// become Set lookups, a pattern holding a `/` is filed under the first segment
// of the path it names, and each group's patterns are joined into one
// alternation — and a path is then tested by a fixed handful of regexes.
// "The path or one of its ancestors matches" is one test, not one per
// ancestor: a trailing `(?:/.*)?` covers every ancestor at once.
// ============================================================================

/** One compiled pattern. */
export interface ExclusionPattern {
  /** The pattern as the operator wrote it, trimmed. */
  source: string;
  /** The pattern's path body: no leading `./` or `/`, no trailing `/`. */
  body: string;
  /** True when it ends in `/` and so matches directories only. */
  directoryOnly: boolean;
  /** The regex body, unanchored; the caller wraps it. */
  regexBody: string;
}

/**
 * Several patterns as one alternation, in the three shapes a caller needs. A
 * `dir/` pattern must never exclude a file named `dir`, so the directory-only
 * patterns cannot share an alternation with the others.
 */
interface PatternGroup {
  /** A file or a directory that is one of the patterns, or sits below one. */
  matches: RegExp | null;
  /** The path itself is a directory-only match. */
  directoryMatch: RegExp | null;
  /** A directory-only pattern matches an ancestor of the path. */
  directoryAncestor: RegExp | null;
}

const EMPTY_GROUP: PatternGroup = { matches: null, directoryMatch: null, directoryAncestor: null };

/**
 * A whole list, compiled so that matching a path costs about the same whatever
 * the list holds:
 *
 * - bare literal names (`node_modules`, `.next`) become Set lookups per segment,
 * - a pattern holding a `/` is kept under the first segment of the path it
 *   names, so a path consults only the few that could name it (`deps/libA` is
 *   looked at for `deps/…`, never for `src/…`),
 * - what remains — bare globs, and paths beginning with a glob — is one
 *   alternation each, so their count does not matter either.
 */
export interface ExclusionSet {
  /** Bare literal names, matched against every path segment. */
  names: Set<string>;
  /** Bare literal names a trailing `/` restricted to directories. */
  directoryNames: Set<string>;
  /** Bare patterns holding a glob character, matched against any segment. */
  nameGlobs: PatternGroup;
  /** Patterns holding a `/` that begin with a literal segment, by that segment. */
  paths: Map<string, PatternGroup>;
  /** Patterns holding a `/` that begin with a glob, which every path consults. */
  wildcardPaths: PatternGroup;
  /** The patterns as stored, for a cache key that follows a saved list. */
  sources: string[];
}

/** Characters a pattern reads as a glob rather than as itself. */
const GLOB_CHARACTERS = /[*?[\]]/;

/** A pattern's path body: no leading `./` or `/`, no trailing `/`. */
function patternBody(pattern: string): string {
  return pattern.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** The first segment of a pattern that names a path from the root. */
function leadingSegment(pattern: string): string {
  const body = patternBody(pattern);
  const slash = body.indexOf("/");
  return slash < 0 ? body : body.slice(0, slash);
}

/** Characters that are literal in a pattern but not in a regular expression. */
function escapeLiteral(character: string): string {
  return /[.*+?^${}()|[\]\\]/.test(character) ? `\\${character}` : character;
}

/**
 * One glob segment as a regular expression fragment. `*` and `?` never match
 * `/`; `**` does. A `[...]` class is copied through, with `\` escaped so a
 * class can never inject a group, and an unterminated class reads literally.
 */
function segmentToRegex(segment: string): string {
  let regex = "";
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (character === "*") {
      if (segment[index + 1] === "*") {
        index++;
        regex += ".*";
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      regex += "[^/]";
      continue;
    }
    if (character === "[") {
      const end = segment.indexOf("]", index + 1);
      if (end > index + 1) {
        const body = segment.slice(index + 1, end).replace(/\\/g, "\\\\");
        regex += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        index = end;
        continue;
      }
    }
    regex += escapeLiteral(character);
  }
  return regex;
}

/**
 * A whole-path pattern as a regular expression body. A leading double-star
 * segment is optional, so a pattern written for a nested cache directory also
 * reaches a top-level one, as gitignore says; every other segment is joined by
 * a required slash.
 */
function pathToRegexBody(body: string): string {
  const segments = body.split("/").filter((segment) => segment.length > 0);
  if (segments.length > 1 && segments[0] === "**") {
    return `(?:.*/)?${segments.slice(1).map(segmentToRegex).join("/")}`;
  }
  return segments.map(segmentToRegex).join("/");
}

/** Compile one pattern, or null when it holds nothing to match. */
export function compileExclusionPattern(pattern: string): ExclusionPattern | null {
  const trimmed = pattern.trim();
  if (!trimmed || trimmed.startsWith("!")) return null;
  const directoryOnly = trimmed.endsWith("/");
  // A leading `/` anchors to the root, as a `/` anywhere else in the pattern
  // does; a bare name is matched at any depth instead.
  const anchoredAtRoot = trimmed.replace(/^\.\//, "").startsWith("/");
  const body = patternBody(trimmed);
  if (!body) return null;

  const anchored = anchoredAtRoot || body.includes("/");
  const regexBody = anchored
    ? pathToRegexBody(body)
    : body.split("/").map(segmentToRegex).join("/");
  return { source: trimmed, body, directoryOnly, regexBody };
}

/** Join patterns into one alternation body, or null when there are none. */
function alternationBody(patterns: readonly ExclusionPattern[]): string | null {
  if (patterns.length === 0) return null;
  return patterns.map((pattern) => `(?:${pattern.regexBody})`).join("|");
}

/**
 * Build the three regexes of a group. `prefix` is empty for a pattern that
 * names a whole path, and an optional any-directory prefix for a bare one that
 * may match any segment; the optional trailing suffix is what makes one test
 * cover the path and every ancestor of it at once.
 */
function groupOf(patterns: readonly ExclusionPattern[], prefix: string): PatternGroup {
  const all = alternationBody(patterns);
  if (all === null) return EMPTY_GROUP;
  const directories = alternationBody(patterns.filter((pattern) => pattern.directoryOnly));
  return {
    matches: new RegExp(`^${prefix}(?:${all})(?:/.*)?$`),
    directoryMatch: directories === null ? null : new RegExp(`^${prefix}(?:${directories})$`),
    directoryAncestor: directories === null ? null : new RegExp(`^${prefix}(?:${directories})(?:/.*)$`),
  };
}

/** Whether a group excludes `text`, given whether `text` names a directory. */
function groupMatches(group: PatternGroup, text: string, isDirectory: boolean): boolean {
  if (group.matches !== null && group.matches.test(text)) return true;
  if (isDirectory && group.directoryMatch !== null && group.directoryMatch.test(text)) return true;
  return group.directoryAncestor !== null && group.directoryAncestor.test(text);
}

/**
 * Compile a whole list. Patterns that cannot match are dropped; the text of the
 * rest is kept in `sources`, which the index cache keys on.
 */
export function compileExclusionPatterns(patterns: readonly string[]): ExclusionSet {
  const names = new Set<string>();
  const directoryNames = new Set<string>();
  const nameGlobPatterns: ExclusionPattern[] = [];
  const wildcardPatterns: ExclusionPattern[] = [];
  const pathBuckets = new Map<string, ExclusionPattern[]>();
  const sources: string[] = [];

  for (const pattern of patterns) {
    const entry = compileExclusionPattern(pattern);
    if (!entry) continue;
    sources.push(entry.source);
    // A `/` means the pattern names a path from the root; without one it names
    // a directory wherever it appears, which the segment loop can decide.
    if (entry.body.includes("/")) {
      const first = leadingSegment(entry.source);
      // A leading glob (`*/x`, `**/x`) could name any path, so it is kept apart
      // rather than filed under a literal first segment that will never match.
      if (GLOB_CHARACTERS.test(first)) wildcardPatterns.push(entry);
      else {
        const bucket = pathBuckets.get(first);
        if (bucket) bucket.push(entry);
        else pathBuckets.set(first, [entry]);
      }
    } else if (GLOB_CHARACTERS.test(entry.body)) {
      nameGlobPatterns.push(entry);
    } else if (entry.directoryOnly) {
      directoryNames.add(entry.body);
    } else {
      names.add(entry.body);
    }
  }

  const paths = new Map<string, PatternGroup>();
  for (const [key, bucket] of pathBuckets) paths.set(key, groupOf(bucket, ""));
  return {
    names,
    directoryNames,
    // A bare glob matches one segment, so `(?:.*/)?` lets it reach any of them.
    nameGlobs: groupOf(nameGlobPatterns, "(?:.*/)?"),
    paths,
    wildcardPaths: groupOf(wildcardPatterns, ""),
    sources,
  };
}

/** Whether the compiled list can exclude anything at all. */
function isEmpty(set: ExclusionSet): boolean {
  return set.names.size === 0
    && set.directoryNames.size === 0
    && set.nameGlobs.matches === null
    && set.nameGlobs.directoryMatch === null
    && set.nameGlobs.directoryAncestor === null
    && set.paths.size === 0
    && set.wildcardPaths.matches === null
    && set.wildcardPaths.directoryMatch === null
    && set.wildcardPaths.directoryAncestor === null;
}

/**
 * Whether `relativePath` (project-relative, `/`-separated, no leading slash)
 * is excluded, directly or because a parent directory is.
 */
export function isExcludedPath(
  relativePath: string,
  patterns: ExclusionSet,
  isDirectory: boolean,
): boolean {
  if (isEmpty(patterns)) return false;
  const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!path) return false;

  // A bare literal name matches a file or a directory of that name, as a
  // gitignore line does; `name/` only counts for a directory. The loop also
  // covers the ancestors, every one of which is a directory.
  if (patterns.names.size > 0 || patterns.directoryNames.size > 0) {
    const segments = path.split("/");
    const lastIndex = segments.length - 1;
    for (let index = 0; index <= lastIndex; index++) {
      const segment = segments[index];
      if (patterns.names.has(segment)) return true;
      if ((index < lastIndex || isDirectory) && patterns.directoryNames.has(segment)) return true;
    }
  }

  if (groupMatches(patterns.nameGlobs, path, isDirectory)) return true;

  // A path pattern is consulted only for the path it names: a bucket lookup on
  // this path's first segment, plus the patterns that begin with a glob.
  const named = patterns.paths.get(path.slice(0, path.indexOf("/") < 0 ? path.length : path.indexOf("/")));
  if (named && groupMatches(named, path, isDirectory)) return true;
  return groupMatches(patterns.wildcardPaths, path, isDirectory);
}
