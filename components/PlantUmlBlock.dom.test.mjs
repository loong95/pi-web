import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { act } = React;
const { createRoot } = await jiti.import("react-dom/client");
const { PlantUmlBlock } = await jiti.import("./PlantUmlBlock.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function svgResponse() {
  return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { "content-type": "image/svg+xml" } });
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
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
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
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });
  return run(dom.window.document.getElementById("app"));
}

function render(root, props) {
  root.render(React.createElement(I18nProvider, null, React.createElement(PlantUmlBlock, props)));
}

test("PlantUmlBlock renders an image and revokes its Blob URL on replacement", async (t) => {
  await withDom(t, async (container) => {
    const calls = [];
    const revoked = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/plantuml/settings") return jsonResponse({ serverUrl: "https://uml.example.test/plantuml" });
      return svgResponse();
    };
    let created = 0;
    URL.createObjectURL = () => `blob:plantuml-${++created}`;
    URL.revokeObjectURL = (url) => revoked.push(url);

    const root = createRoot(container);
    await act(async () => render(root, { code: "@startuml\nAlice -> Bob\n@enduml", lang: "plantuml", defaultPreview: true }));
    await settle();
    await settle();

    const image = container.querySelector("img");
    assert.equal(image?.getAttribute("src"), "blob:plantuml-1");
    assert.equal(calls.filter((call) => call.url === "/api/plantuml/render").length, 1);
    assert.deepEqual(JSON.parse(calls.find((call) => call.url === "/api/plantuml/render").init.body), {
      source: "@startuml\nAlice -> Bob\n@enduml",
    });

    await act(async () => render(root, { code: "@startuml\nBob -> Alice\n@enduml", lang: "plantuml", defaultPreview: true }));
    await settle();
    await settle();
    assert.equal(container.querySelector("img")?.getAttribute("src"), "blob:plantuml-2");
    assert.deepEqual(revoked, ["blob:plantuml-1"]);

    await act(async () => root.unmount());
    assert.deepEqual(revoked, ["blob:plantuml-1", "blob:plantuml-2"]);
  });
});

test("PlantUmlBlock does not render when disabled and aborts stale render requests", async (t) => {
  await withDom(t, async (container) => {
    let settingsEnabled = false;
    let renderSignal;
    globalThis.fetch = (url, init = {}) => {
      if (url === "/api/plantuml/settings") return Promise.resolve(jsonResponse({ serverUrl: settingsEnabled ? "https://uml.example.test" : "" }));
      renderSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    };

    const root = createRoot(container);
    await act(async () => render(root, { code: "@startuml\nAlice -> Bob\n@enduml", lang: "puml", defaultPreview: true }));
    await settle();
    assert.equal(renderSignal, undefined, "disabled configuration must not call the render API");

    settingsEnabled = true;
    await act(async () => window.dispatchEvent(new Event("pi-web:plantuml-settings-changed")));
    await settle();
    assert.equal(renderSignal instanceof AbortSignal, true);

    await act(async () => root.unmount());
    assert.equal(renderSignal.aborted, true);
  });
});
