import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("压缩后的会话仍可根据持久化消息数生成标题", () => {
  assert.match(
    source,
    /\(sessionStats\?\.userMessages \?\? 0\) > 0 \|\| selectedSession\.messageCount > 0/,
  );
});

test("尚未落盘的会话不会触发依赖 JSONL 的自动命名", () => {
  assert.match(
    source,
    /const disabled = !selectedSession \|\| selectedSession\.transient \|\| !hasMessages/,
  );
});

test("会话落盘后会用服务端记录清除临时状态", () => {
  assert.match(source, /\{ \.\.\.prev, \.\.\.full, transient: full\.transient \?\? false \}/);
  assert.match(source, /if \(selectedSession\) hydrateSelectedSession\(selectedSession\.id\)/);
});

const autoTitleSource = source.slice(
  source.indexOf("const requestAutoTitle"),
  source.indexOf("const handleAgentEnd"),
);

test("首轮完成后在后台请求自动命名，且每个会话只请求一次", () => {
  assert.match(
    source,
    /if \(selectedSession && !selectedSession\.name\) requestAutoTitle\(selectedSession\)/,
  );
  assert.match(autoTitleSource, /if \(autoTitleRequestedRef\.current\.has\(session\.id\)\) return;/);
  assert.match(autoTitleSource, /body: JSON\.stringify\(\{ trigger: "auto" \}\)/);
  assert.match(autoTitleSource, /applyGeneratedTitle\(session\.id, body\.title\.trim\(\)\)/);
});

test("自动命名失败不会影响聊天与状态提示", () => {
  assert.match(autoTitleSource, /if \(!response\.ok\) return;/);
  assert.match(autoTitleSource, /\} catch \{/);
  assert.doesNotMatch(autoTitleSource, /setAutoNameStatus/);
  assert.doesNotMatch(autoTitleSource, /console\.error/);
});

test("手动生成仍可覆盖自动命名的状态与标题", () => {
  assert.match(source, /autoTitleRequestedRef\.current\.add\(sessionId\)/);
  assert.match(source, /applyGeneratedTitle\(sessionId, title\)/);
});
