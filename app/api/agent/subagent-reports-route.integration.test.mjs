import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
});

// The composer's chip: a finished background subagent's result is recorded for its parent and
// the page reads it with GET. The runtime never sends it on its own; POST is the user's click,
// and it is the only delivery path.
test("the subagent-reports route lists unread results and delivers only on POST", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-subagent-reports-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  const cwd = join(dir, "project");
  await mkdir(cwd);
  await writeFile(join(dir, "settings.json"), "{}");

  const { startRpcSession } = await jiti.import("@/lib/rpc-manager");
  const { createSubagentController } = await jiti.import("@/lib/subagent-runtime");
  const { GET, POST } = await jiti.import("./[id]/subagent-reports/route.ts");

  const started = await startRpcSession("__new__subagent-reports", "", cwd, {});
  t.after(async () => { await started.session.shutdown(); });
  const sessionId = started.session.sessionId;
  const emitted = [];
  started.session.onEvent((event) => emitted.push(event));

  // A controller over the same live wrapper, so the route reads the same pending table.
  const controller = createSubagentController({
    getSession: (id) => (id === sessionId ? started.session : undefined),
    registerSession: () => {},
    reopenSession: async () => started.session,
    resolveSessionPath: async () => started.session.sessionFile,
    invalidateSessionList: () => {},
    notifyPendingReports: (id, reports) => {
      if (id === sessionId) started.session.notifyPendingSubagentReports(reports);
    },
  });

  const params = { params: Promise.resolve({ id: sessionId }) };
  const empty = await (await GET(new Request("http://test/"), params)).json();
  assert.deepEqual(empty.reports, []);

  const run = {
    sessionId: "child-fixture",
    sessionPath: join(dir, "child.jsonl"),
    parentSessionId: sessionId,
    parentToolCallId: "fixture-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser is in lib/parser.ts",
  };
  await controller.extensionRuntime.scheduleParentReport(run);

  // The chip's read: identity and state, never the result text.
  const listed = await (await GET(new Request("http://test/"), params)).json();
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].sessionId, "child-fixture");
  assert.equal(listed.reports[0].description, "Inspect parser");
  assert.equal(listed.reports[0].status, "completed");
  assert.equal(listed.reports[0].completedAt, "2026-01-01T00:01:00.000Z");
  assert.ok(!JSON.stringify(listed).includes("lib/parser.ts"), "the chip never carries the result");

  // Recording it also reached the page's stream, so a connected chip updates without polling.
  assert.equal(emitted.filter((event) => event.type === "subagent_reports").length, 1);
  assert.equal(emitted.at(-1).reports[0].sessionId, "child-fixture");

  // The user's click is the only delivery path.
  const delivered = await (await POST(new Request("http://test/", { method: "POST" }), params)).json();
  assert.equal(delivered.success, true);
  assert.deepEqual(delivered.reports.map((report) => report.sessionId), ["child-fixture"]);
  const after = await (await GET(new Request("http://test/"), params)).json();
  assert.deepEqual(after.reports, []);

  // A second click has nothing left to send.
  const twice = await (await POST(new Request("http://test/", { method: "POST" }), params)).json();
  assert.deepEqual(twice.reports, []);
});

test("the route reports an empty list for a session the server does not hold", async () => {
  const { GET } = await jiti.import("./[id]/subagent-reports/route.ts");
  const reply = await GET(new Request("http://test/"), { params: Promise.resolve({ id: "no-such-session" }) });
  assert.equal(reply.status, 200);
  assert.deepEqual((await reply.json()).reports, []);
});
