import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, createContext } from "node:vm";
import ts from "typescript";

// The page never sends into a subagent: its tab has no composer (ChatWindow), and
// every send funnel in useAgentSession asks this gate first, so another view — a
// restored draft, a future button, an extension status command — cannot send
// either. The server still accepts a prompt for such a session; this is the page's
// rule (docs/agents/subagents.md).
const text = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("useAgentSession.ts", text, ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);

function callback(name) {
  const node = nodes.find((item) => ts.isVariableDeclaration(item) && item.name.getText(source) === name);
  assert.ok(node, `missing ${name}`);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText);
}

/** Runs the real gate with the render-scoped values it closes over. */
function gate(session) {
  const notices = [];
  const context = createContext({
    sessionRelationKind: session?.relation?.kind,
    translateForSend: (key) => `t:${key}`,
    addNotice: (notice) => notices.push(notice),
  });
  return { refuses: callback("refuseSubagentSend").runInContext(context), notices };
}

test("a subagent session refuses every send, with a notice naming the rule", () => {
  const mode = gate({ id: "child", relation: { kind: "subagent", parentSessionId: "parent" } });
  assert.equal(mode.refuses(), true);
  assert.equal(mode.notices.length, 1, "one notice per refused send");
  assert.equal(mode.notices[0].type, "warning");
  assert.equal(mode.notices[0].message, "t:subagent.readOnly.blocked");
});

test("a side chat, a normal session and a fresh composer still send", () => {
  assert.equal(gate({ id: "side", relation: { kind: "side", parentSessionId: "parent" } }).refuses(), false);
  assert.equal(gate({ id: "main" }).refuses(), false);
  assert.equal(gate(null).refuses(), false);
  assert.equal(gate(undefined).refuses(), false);
});

test("handleSend, the steer/follow-up funnel and the chip's POST all pass the gate", () => {
  for (const name of ["handleSend", "sendStreamingPrompt", "handleDeliverSubagentReports"]) {
    const node = nodes.find((item) => ts.isVariableDeclaration(item) && item.name.getText(source) === name);
    assert.ok(node, `missing ${name}`);
    assert.match(node.initializer.arguments[0].getText(source), /refuseSubagentSend\(\)/, `${name} must refuse a subagent before sending`);
    // The gate closes over the session's relation: re-create the callback when it changes.
    assert.match(node.initializer.arguments[1].getText(source), /refuseSubagentSend\b/, `${name} must depend on the gate`);
  }
});
