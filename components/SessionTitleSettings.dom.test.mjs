import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { act } = React;
const { createRoot } = await jiti.import("react-dom/client");
const { SessionTitleSettings } = await jiti.import("./SessionTitleSettings.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function withDom(t, run) {
  const dom = new JSDOM("<!doctype html><div id=app></div>", { url: "http://localhost/" });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  const originalDescriptors = new Map([
    "window", "document", "navigator", "HTMLElement", "Event", "IS_REACT_ACT_ENVIRONMENT", "fetch",
  ].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const setGlobal = (key, value) => Object.defineProperty(globalThis, key, {
    value,
    configurable: true,
    writable: true,
  });
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("HTMLElement", dom.window.HTMLElement);
  setGlobal("Event", dom.window.Event);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of originalDescriptors) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
  });
  return run(dom.window.document.getElementById("app"));
}

async function render(container) {
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(I18nProvider, null, React.createElement(SessionTitleSettings)));
  });
  await settle();
  await settle();
  return root;
}

function stubFetch(calls, { settings, putFails = false }) {
  let current = { ...settings };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.startsWith("/api/models")) {
      return jsonResponse({ modelList: [{ id: "haiku-4-5", name: "Haiku 4.5", provider: "anthropic" }] });
    }
    if ((init.method ?? "GET") === "PUT") {
      if (putFails) return jsonResponse({ error: "boom" }, 500);
      // The route answers with the settings it just persisted.
      current = { ...current, ...JSON.parse(init.body) };
    }
    return jsonResponse(current);
  };
}

test("toggling auto naming persists the setting", async (t) => {
  await withDom(t, async (container) => {
    const calls = [];
    stubFetch(calls, { settings: { autoEnabled: false, model: null } });
    const root = await render(container);

    const toggle = container.querySelector('[role="switch"]');
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(container.querySelector('[aria-label="Title model"]').textContent, "Session model");

    await act(async () => toggle.click());
    await settle();

    const put = calls.find((call) => call.init?.method === "PUT");
    assert.deepEqual(JSON.parse(put.init.body), { autoEnabled: true });
    assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "true");

    await act(async () => root.unmount());
  });
});

test("a failed save rolls the switch back and reports it inline", async (t) => {
  await withDom(t, async (container) => {
    const calls = [];
    stubFetch(calls, { settings: { autoEnabled: false, model: null }, putFails: true });
    const root = await render(container);

    await act(async () => container.querySelector('[role="switch"]').click());
    await settle();

    assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
    assert.match(container.querySelector('[role="alert"]').textContent, /Could not save the title settings: boom/);

    await act(async () => root.unmount());
  });
});

test("an unexpected settings payload is reported instead of applied", async (t) => {
  await withDom(t, async (container) => {
    const calls = [];
    stubFetch(calls, { settings: { model: null } });
    const root = await render(container);

    assert.equal(container.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /Could not load the title settings/,
    );

    await act(async () => root.unmount());
  });
});

test("choosing a title model persists the provider/model pair", async (t) => {
  await withDom(t, async (container) => {
    const calls = [];
    stubFetch(calls, { settings: { autoEnabled: true, model: null } });
    const root = await render(container);

    await act(async () => container.querySelector('[aria-label="Title model"]').click());
    await settle();

    const option = Array.from(container.querySelectorAll('[role="option"]'))
      .find((candidate) => candidate.textContent.includes("Haiku 4.5"));
    assert.ok(option, "the model list should render the configured model");
    await act(async () => option.click());
    await settle();

    const put = calls.find((call) => call.init?.method === "PUT");
    assert.deepEqual(JSON.parse(put.init.body), { model: { provider: "anthropic", modelId: "haiku-4-5" } });
    assert.equal(container.querySelector('[aria-label="Title model"]').textContent, "Haiku 4.5");

    await act(async () => root.unmount());
  });
});
