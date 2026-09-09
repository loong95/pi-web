import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST: render } = await jiti.import("./render/route.ts");
const { GET: getSettings, PUT: putSettings } = await jiti.import("./settings/route.ts");
const { writePlantUmlSettings } = await jiti.import("@/lib/plantuml.ts");

function apiRequest(path, body, headers = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { host: "localhost", ...headers },
    body,
  });
}

async function withAgentDir(t, run) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-plantuml-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return run(root);
}

async function startSvgServer(t, status = 200, contentType = "image/svg+xml") {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": contentType });
    response.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}/plantuml`;
}

test("PlantUML render route rejects untrusted and malformed requests", async (t) => {
  await withAgentDir(t, async () => {
    const untrusted = await render(new Request("http://localhost/api/plantuml/render", {
      method: "POST",
      headers: { host: "example.test", "content-type": "application/json" },
      body: JSON.stringify({ source: "@startuml\n@enduml" }),
    }));
    assert.equal(untrusted.status, 403);

    const nonJson = await render(apiRequest("/api/plantuml/render", "source", { "content-type": "text/plain" }));
    assert.equal(nonJson.status, 415);

    const missing = await render(apiRequest("/api/plantuml/render", JSON.stringify({}), { "content-type": "application/json" }));
    assert.equal(missing.status, 400);

    const empty = await render(apiRequest("/api/plantuml/render", JSON.stringify({ source: "  " }), { "content-type": "application/json" }));
    assert.equal(empty.status, 400);

    const oversized = await render(apiRequest("/api/plantuml/render", JSON.stringify({ source: "x".repeat(256 * 1024 + 1) }), { "content-type": "application/json" }));
    assert.equal(oversized.status, 413);
  });
});

test("PlantUML render route reports an unconfigured server", async (t) => {
  await withAgentDir(t, async () => {
    const response = await render(apiRequest("/api/plantuml/render", JSON.stringify({ source: "@startuml\n@enduml" }), { "content-type": "application/json" }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "PlantUML Server is not configured" });
  });
});

test("PlantUML render route returns an SVG with private proxy headers", async (t) => {
  await withAgentDir(t, async (agentDir) => {
    writePlantUmlSettings(await startSvgServer(t), join(agentDir, "plantuml.json"));
    const response = await render(apiRequest("/api/plantuml/render", JSON.stringify({ source: "@startuml\nAlice -> Bob\n@enduml" }), { "content-type": "application/json" }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await response.text(), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  });
});

test("PlantUML settings route validates and persists the configured server", async (t) => {
  await withAgentDir(t, async () => {
    const initial = await getSettings();
    assert.deepEqual(await initial.json(), { serverUrl: "" });

    const nonJson = await putSettings(apiRequest("/api/plantuml/settings", "server", { "content-type": "text/plain" }));
    assert.equal(nonJson.status, 415);

    const insecure = await putSettings(apiRequest("/api/plantuml/settings", JSON.stringify({ serverUrl: "http://example.test" }), { "content-type": "application/json" }));
    assert.equal(insecure.status, 400);

    const saved = await putSettings(apiRequest("/api/plantuml/settings", JSON.stringify({ serverUrl: "https://uml.example.test/plantuml/" }), { "content-type": "application/json" }));
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { serverUrl: "https://uml.example.test/plantuml" });
  });
});
