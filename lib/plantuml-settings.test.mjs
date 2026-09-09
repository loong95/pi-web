import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  readPlantUmlSettings,
  writePlantUmlSettings,
} = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./plantuml.ts");

test("PlantUML settings default to a disabled server and preserve future fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-plantuml-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "plantuml.json");

  assert.deepEqual(readPlantUmlSettings(settingsPath), { serverUrl: "" });
  writePlantUmlSettings("https://uml.example.test/plantuml", settingsPath);
  assert.deepEqual(readPlantUmlSettings(settingsPath), { serverUrl: "https://uml.example.test/plantuml" });

  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: true }));
  writePlantUmlSettings("", settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    serverUrl: "",
    futureSetting: true,
  });
});

test("damaged PlantUML settings are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-plantuml-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "plantuml.json");
  await writeFile(settingsPath, "{");

  assert.throws(() => readPlantUmlSettings(settingsPath));
  assert.throws(() => writePlantUmlSettings("https://uml.example.test", settingsPath));
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});
