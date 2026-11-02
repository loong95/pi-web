import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createSubagentController, hasUnsettledSubagentRun } = await jiti.import("./subagent-runtime.ts");
const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture phase");
    await tick();
  }
}

test("real SDK: a main session announces its task once, after the run the user's status send starts (#1434)", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-family-completion-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const sessions = new Map();
  t.after(async () => {
    for (const wrapper of sessions.values()) {
      wrapper.destroy();
    }
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents", "fixture.md"), [
    "---", "description: Synthetic notification fixture.", "tools: read",
    "load_skills: false", "load_extensions: false", "mcp: off", "codemode: off", "---", "Report the result.",
  ].join("\n"));
  const faux = fauxProvider({ models: [{ id: "family-fixture" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  const { session: parent } = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("family-fixture"),
  });
  const pushed = [];
  const root = new AgentSessionWrapper(parent, { onAgentRunComplete: (id) => pushed.push(id) });
  sessions.set(parent.sessionId, root);
  root.start();
  const ends = [];
  root.onEvent((event) => { if (event.type === "agent_settled" || event.type === "prompt_done") ends.push(event); });
  const controller = createSubagentController({
    getSession: (id) => sessions.get(id),
    registerSession: (inner) => {
      const wrapper = new AgentSessionWrapper(inner, { suppressCompletionNotifications: true });
      sessions.set(inner.sessionId, wrapper);
      wrapper.start();
      return wrapper;
    },
    resolveSessionPath: async (id) => sessions.get(id)?.sessionFile ?? null,
    reopenSession: async () => { throw new Error("Fixture should keep its sessions alive"); },
    invalidateSessionList() {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const firstReply = Promise.withResolvers();
  const childReply = Promise.withResolvers();
  const finalReply = Promise.withResolvers();
  let parentEntered = false;
  let childEntered = false;
  let finalEntered = false;
  faux.setResponses([
    async () => { parentEntered = true; await firstReply.promise; return answer("Background task dispatched."); },
    async () => { childEntered = true; await childReply.promise; return answer("Child report."); },
    async () => { finalEntered = true; await finalReply.promise; return answer("Final synthesis."); },
  ]);
  // Release all synthetic model calls even if an assertion fails; never leave a real run hanging.
  t.after(() => { firstReply.resolve(); childReply.resolve(); finalReply.resolve(); });
  await root.send({ type: "prompt", message: "Delegate a task, then synthesize its report." });
  await until(() => parentEntered);
  const execution = await controller.extensionRuntime.start({
    parentContext: { sessionManager: parent.sessionManager }, parentToolCallId: "fixture-call",
    profile: "fixture", task: "Return a report.", description: "Background fixture", runInBackground: true,
  });
  let reportedRun;
  const notification = execution.completion.then((run) => {
    reportedRun = run;
    return controller.extensionRuntime.scheduleParentReport(run);
  });
  await until(() => childEntered);
  firstReply.resolve();
  await until(() => ends.some((event) => event.type === "prompt_done"));
  assert.equal(root.isRunning(), false);
  assert.equal(hasUnsettledSubagentRun(root.sessionId), true);
  assert.deepEqual(pushed, [], "the main session is idle, but its child is still running");
  // The page reads the same from the run's end: no chime, no notification.
  assert.deepEqual(ends.map((event) => [event.type, event.subagentsActive]), [
    ["agent_settled", true],
    ["prompt_done", true],
  ]);

  childReply.resolve();
  await notification;
  // The child's result is recorded, not pushed: the parent stays idle, and the unread result
  // waits for the user's chip instead of starting a turn on its own.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root.isRunning(), false, "the report never starts a turn on its own");
  assert.equal(hasUnsettledSubagentRun(root.sessionId), false, "an unread result does not hold the session");
  assert.deepEqual(controller.pendingReports(root.sessionId).map((run) => run.sessionId), [reportedRun.sessionId]);
  // The first run ended while the child was still running, and the child's finish alone does not
  // announce the task: the chip is the signal the user acts on.
  assert.deepEqual(pushed, []);

  // The user clicks the chip's send button: the status turn runs, and its end announces the task.
  // The send is awaited only after the turn has entered (the SDK's sendCustomMessage resolves once
  // that turn settled), so its reply is released here, not before.
  const delivering = controller.deliverReports(root.sessionId);
  await until(() => finalEntered);
  finalReply.resolve();
  await until(() => !root.isRunning());
  await delivering;
  assert.ok(parent.getLastAssistantText()?.length > 0, "the parent answers the status report");
  assert.deepEqual(pushed, [root.sessionId]);
  assert.ok(ends.some((event) => event.type === "agent_settled" && event.aborted === false));
  assert.deepEqual(controller.pendingReports(root.sessionId), []);
});
