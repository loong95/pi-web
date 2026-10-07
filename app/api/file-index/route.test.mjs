import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-index-route-")));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(path.join(root, "gitconfig"), "");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
process.env.GIT_CEILING_DIRECTORIES = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
allowFileRoot(root);

function write(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/** The stored settings file the route reads, replaced per test. */
function storeSettings(settings) {
  const settingsPath = path.join(agentDir, "file-browser.json");
  if (settings === null) fs.rmSync(settingsPath, { force: true });
  else fs.writeFileSync(settingsPath, JSON.stringify(settings));
}

function indexRequest(cwd, query = "") {
  const url = `http://localhost/api/file-index?cwd=${encodeURIComponent(cwd)}${query ? `&q=${encodeURIComponent(query)}` : ""}`;
  return GET(new NextRequest(url));
}

async function filesFor(cwd) {
  const response = await indexRequest(cwd);
  assert.equal(response.status, 200);
  return (await response.json()).files;
}

async function matchesFor(cwd, query) {
  const response = await indexRequest(cwd, query);
  assert.equal(response.status, 200);
  return (await response.json()).matches.map((entry) => entry.path);
}

test("without settings the index is Git's tracked and unignored view", async () => {
  storeSettings(null);
  const repo = path.join(root, "plain-repo");
  write(path.join(repo, "src/main.ts"));
  write(path.join(repo, "vendor/lib.js"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", "src", "vendor"]);

  assert.deepEqual(await filesFor(repo), ["src/main.ts", "vendor/lib.js"]);
});

test("searchExclude drops a path Git tracks or shows, and its contents", async () => {
  storeSettings({ version: 1, searchExclude: ["vendor", "deps/libA"] });
  const repo = path.join(root, "excluded-repo");
  write(path.join(repo, "src/main.ts"));
  write(path.join(repo, "vendor/lib.js"));
  write(path.join(repo, "nested/vendor/deep.js"));
  write(path.join(repo, "deps/libA/index.ts"));
  write(path.join(repo, "other/deps/libA/index.ts"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", "."]);

  assert.deepEqual(await filesFor(repo), ["other/deps/libA/index.ts", "src/main.ts"]);
});

test("an excluded path is gone from a query's matches too", async () => {
  storeSettings({ version: 1, searchExclude: ["vendor"] });
  const repo = path.join(root, "excluded-query-repo");
  write(path.join(repo, "vendor/lib.js"));
  write(path.join(repo, "src/vendorize.ts"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", "."]);

  assert.deepEqual(await matchesFor(repo, "vendor"), ["src/vendorize.ts"]);
});

test("a saved pattern applies to the next listing, without a restart", async () => {
  storeSettings(null);
  const repo = path.join(root, "reload-repo");
  write(path.join(repo, "vendor/lib.js"));
  write(path.join(repo, "src/main.ts"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", "."]);

  assert.deepEqual(await filesFor(repo), ["src/main.ts", "vendor/lib.js"]);
  storeSettings({ version: 1, searchExclude: ["vendor"] });
  // The per-cwd cache is keyed by the patterns, so the change is never served
  // the previous filter's answer.
  assert.deepEqual(await filesFor(repo), ["src/main.ts"]);
});

test("the exclusion also filters the readdir fallback outside Git", async () => {
  storeSettings({ version: 1, searchExclude: ["node_modules", "keep/"] });
  const plain = path.join(root, "plain-dir");
  write(path.join(plain, "src/main.ts"));
  write(path.join(plain, "node_modules/pkg/index.js"));
  write(path.join(plain, "keep/file.ts"));
  write(path.join(plain, "keep-extra/file.ts"));

  assert.deepEqual(await filesFor(plain), ["keep-extra/file.ts", "src/main.ts"]);
});

test("an unreadable settings file means no exclusions, never a failed listing", async () => {
  const repo = path.join(root, "broken-settings-repo");
  write(path.join(repo, "src/main.ts"));
  write(path.join(repo, "vendor/lib.js"));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "add", "."]);

  fs.writeFileSync(path.join(agentDir, "file-browser.json"), "{not json");
  assert.deepEqual(await filesFor(repo), ["src/main.ts", "vendor/lib.js"]);
  storeSettings(null);
});
