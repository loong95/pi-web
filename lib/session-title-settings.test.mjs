import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  readSessionTitleSettings,
  readSessionTitleSettingsSafely,
  writeSessionTitleSettings,
} = await createJiti(import.meta.url).import("./session-title-settings.ts");

async function tempSettingsPath(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-title-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "session-title.json");
}

test("session title settings default to off with no model override", async (t) => {
  const settingsPath = await tempSettingsPath(t);

  assert.deepEqual(readSessionTitleSettings(settingsPath), { autoEnabled: false, model: null });
});

test("session title settings persist the toggle and the model", async (t) => {
  const settingsPath = await tempSettingsPath(t);

  assert.deepEqual(
    writeSessionTitleSettings({ autoEnabled: true }, settingsPath),
    { autoEnabled: true, model: null },
  );
  assert.deepEqual(
    writeSessionTitleSettings({ model: { provider: "anthropic", modelId: "claude-haiku-4-5" } }, settingsPath),
    { autoEnabled: true, model: { provider: "anthropic", modelId: "claude-haiku-4-5" } },
  );
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    autoEnabled: true,
    model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
  });
});

test("clearing the model falls back to the session model and keeps the toggle", async (t) => {
  const settingsPath = await tempSettingsPath(t);

  writeSessionTitleSettings({ autoEnabled: true, model: { provider: "x", modelId: "y" } }, settingsPath);
  assert.deepEqual(
    writeSessionTitleSettings({ model: null }, settingsPath),
    { autoEnabled: true, model: null },
  );
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, autoEnabled: true });
});

test("session title settings preserve fields owned by other tools", async (t) => {
  const settingsPath = await tempSettingsPath(t);
  await writeFile(settingsPath, JSON.stringify({ version: 1, futureSetting: 3 }));

  writeSessionTitleSettings({ autoEnabled: true }, settingsPath);

  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")),
    { version: 1, futureSetting: 3, autoEnabled: true },
  );
});

test("an incomplete stored model is ignored", async (t) => {
  const settingsPath = await tempSettingsPath(t);
  await writeFile(settingsPath, JSON.stringify({ version: 1, autoEnabled: true, model: { provider: "anthropic" } }));

  assert.deepEqual(readSessionTitleSettings(settingsPath), { autoEnabled: true, model: null });
});

test("rejects invalid writes", async (t) => {
  const settingsPath = await tempSettingsPath(t);

  assert.throws(() => writeSessionTitleSettings({ autoEnabled: "yes" }, settingsPath), /autoEnabled must be a boolean/);
  assert.throws(
    () => writeSessionTitleSettings({ model: { provider: "", modelId: "x" } }, settingsPath),
    /model must be null/,
  );
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const settingsPath = await tempSettingsPath(t);
  await writeFile(settingsPath, "{");

  assert.deepEqual(readSessionTitleSettingsSafely(settingsPath), { autoEnabled: false, model: null });
  assert.throws(() => readSessionTitleSettings(settingsPath));
  assert.throws(() => writeSessionTitleSettings({ autoEnabled: true }, settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});
