import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-browser-route-")));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir, { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(root, { recursive: true, force: true });
});

const { GET, PUT } = await createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
}).import("./route.ts");

function put(body, contentType = "application/json") {
  return PUT(new Request("http://localhost/api/file-browser/settings", {
    method: "PUT",
    headers: { host: "localhost", "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("GET answers the stored settings, defaults when there are none", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { searchExclude: [] });
});

test("PUT stores the list, trimmed and deduplicated", async () => {
  const response = await put({ searchExclude: ["node_modules", " deps/libA ", "node_modules"] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { searchExclude: ["node_modules", "deps/libA"] });
});

test("PUT refuses a body that changes nothing", async () => {
  const response = await put({});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /searchExclude is required/);
});

test("PUT refuses a wrongly typed value with a 400", async () => {
  for (const body of [{ searchExclude: "node_modules" }, { searchExclude: ["ok", 7] }]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("PUT refuses an untrusted origin, a wrong content type and invalid JSON", async () => {
  const crossOrigin = await PUT(new Request("http://localhost/api/file-browser/settings", {
    method: "PUT",
    headers: { host: "localhost", origin: "http://evil.example", "content-type": "application/json" },
    body: JSON.stringify({ searchExclude: ["vendor"] }),
  }));
  assert.equal(crossOrigin.status, 403);

  const wrongType = await put({ searchExclude: ["vendor"] }, "text/plain");
  assert.equal(wrongType.status, 415);

  const broken = await put("{not json");
  assert.equal(broken.status, 400);
});

test("the settings file is written where the routes read it", async () => {
  await put({ searchExclude: ["vendor"] });
  const stored = JSON.parse(fs.readFileSync(path.join(agentDir, "file-browser.json"), "utf8"));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.searchExclude, ["vendor"]);
});
