import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-session-title-settings-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/session-title/settings", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: JSON.stringify(body),
  });
}

test("title settings default to disabled with no model override", async () => {
  const response = await GET();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { autoEnabled: false, model: null });
});

test("title settings persist the toggle and the model", async () => {
  let response = await PUT(request({ autoEnabled: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { autoEnabled: true, model: null });

  response = await PUT(request({ model: { provider: "anthropic", modelId: "claude-haiku-4-5" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    autoEnabled: true,
    model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "session-title.json"), "utf8")),
    {
      version: 1,
      autoEnabled: true,
      model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
    },
  );

  response = await PUT(request({ model: null }));
  assert.deepEqual(await response.json(), { autoEnabled: true, model: null });
});

test("title settings route validates mutations", async () => {
  let response = await PUT(request({}));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "autoEnabled or model is required" });

  response = await PUT(request({ autoEnabled: "yes" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "autoEnabled must be a boolean" });

  response = await PUT(request({ model: { provider: "anthropic" } }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "model must be null or { provider, modelId }" });

  response = await PUT(request({ autoEnabled: true }, "text/plain"));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });
});
