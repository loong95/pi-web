import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-auto-name-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function post(body) {
  const request = new Request("http://localhost/api/sessions/missing/auto-name", {
    method: "POST",
    headers: { Host: "localhost", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return POST(request, { params: Promise.resolve({ id: "missing-session-id" }) });
}

async function enableAutoNaming() {
  await writeFile(
    join(testAgentDir, "session-title.json"),
    JSON.stringify({ version: 1, autoEnabled: true }),
  );
}

test("background naming is a no-op while the feature is off", async () => {
  // The session id does not exist: a request that touched the session first
  // would answer 404 instead of the skip.
  const response = await post({ trigger: "auto" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { skipped: "disabled" });
});

test("an explicit request is never disabled by the setting", async () => {
  const response = await post(undefined);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
});

test("background naming proceeds once the setting is on", async () => {
  await enableAutoNaming();

  const response = await post({ trigger: "auto" });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
});

test("an unreadable settings file disables background naming", async () => {
  await writeFile(join(testAgentDir, "session-title.json"), "{");

  const response = await post({ trigger: "auto" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { skipped: "disabled" });
});
