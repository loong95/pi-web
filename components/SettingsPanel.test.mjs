import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");

test("the trust dialog Settings › MCP opens stacks above Settings", () => {
  const zIndex = (selector) => Number(cssSource.match(new RegExp(`\\${selector} \\{[^}]*z-index: (\\d+);`))?.[1]);
  assert.ok(zIndex(".project-trust-backdrop") > zIndex(".settings-dialog-backdrop"));
});

test("the login page returns only to a destination safeLoginDestination() accepts", () => {
  assert.match(loginSource, /safeLoginDestination\(destination, window\.location\.origin\)/);
});

test("lists the Experimental tab last and moves PlantUML into it", async () => {
  const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
  const experimentalSource = await readFile(new URL("./ExperimentalSettings.tsx", import.meta.url), "utf8");
  const tabsBlock = panelSource.slice(
    panelSource.indexOf("const sections:"),
    panelSource.indexOf("];", panelSource.indexOf("const sections:")),
  );
  assert.match(tabsBlock, /\{ id: "experimental", label: t\("settings\.experimental"\) \},/);
  assert.ok(tabsBlock.indexOf('id: "experimental"') > tabsBlock.indexOf('id: "plugins"'), "Experimental must be the last tab");
  assert.match(panelSource, /sectionHost\("experimental", <ExperimentalSettings \/>\)/);
  assert.doesNotMatch(panelSource, /<PlantUmlSettings \/>/);
  assert.match(experimentalSource, /<PlantUmlSettings \/>/);
  assert.match(experimentalSource, /t\("settings\.onlyCurrentWorktree"\)/);
  assert.match(experimentalSource, /setWorktreeSessionScopeEnabled\(enabled\)/);
});
