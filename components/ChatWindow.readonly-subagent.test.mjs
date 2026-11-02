import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// A subagent's right-panel tab is a transcript of a run the parent started, not a
// chat: with a composer there the tab reads like the main chat, and a message
// typed into it starts a turn in the child (upstream's SessionChatPanel does
// exactly that). Pi Web keeps the tab read-only; side chats stay writable.
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("the subagent tab derives its read-only mode from the session's relation", () => {
  assert.match(
    source,
    /const readOnlySession = session\?\.relation\?\.kind === "subagent";/,
    "only subagent sessions are read-only: a side chat is talked to",
  );
});

test("a read-only transcript offers no way to send", () => {
  // The composer's whole write surface goes with it: text, attach, model, slash commands.
  assert.match(
    source,
    /\{readOnlySession \? <SubagentReadOnlyBar \/> : chatInputElement\}/,
    "the composer is replaced by the read-only note",
  );
  // Editing a message rewrites the session's branch, and the chip sends a status prompt.
  assert.match(source, /onEditContent=\{sessionBusy \|\| readOnlySession \? undefined : handleEditContent\}/);
  assert.match(source, /\{!readOnlySession && pendingSubagentReports\.length > 0 && \(/);
  // `command:` status buttons send a slash command.
  assert.match(source, /onCommand=\{readOnlySession \? undefined : handleSend\}/);
  // A drop would upload into the child's working directory.
  assert.match(source, /const dropHandlers = readOnlySession\s*\n\s*\? \{ onDragEnter: undefined/);
  assert.match(source, /onDrop=\{dropHandlers\.onDrop\}/);
  // A seed prompt (a side chat's first message) would be a send too.
  assert.match(source, /if \(readOnlySession \|\| loading \|\| error \|\| !initialPrompt/);
});

test("the read-only note says what the tab is and where a message belongs", async () => {
  const jiti = createJiti(import.meta.url);
  const locales = {
    en: (await jiti.import("../lib/i18n/messages/en.ts")).enLocale,
    "zh-CN": (await jiti.import("../lib/i18n/messages/zh-CN.ts")).zhCNLocale,
    "zh-TW": (await jiti.import("../lib/i18n/messages/zh-TW.ts")).zhTWLocale,
  };
  for (const [locale, messages] of Object.entries(locales)) {
    for (const key of ["subagent.readOnly.title", "subagent.readOnly.hint"]) {
      assert.equal(typeof messages.messages[key], "string", `${locale} is missing ${key}`);
      assert.ok(messages.messages[key].trim().length > 0, `${locale} has an empty ${key}`);
    }
  }
  assert.match(source, /t\("subagent\.readOnly\.title"\)/);
  assert.match(source, /t\("subagent\.readOnly\.hint"\)/);
});
