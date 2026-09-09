import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { PlantUmlBlock } = await jiti.import("./PlantUmlBlock.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderPlantUml(props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(PlantUmlBlock, props)));
}

test("PlantUmlBlock initially uses the normal source fallback until settings load", () => {
  const html = renderPlantUml({ code: "@startuml\nAlice -> Bob\n@enduml", lang: "plantuml", defaultPreview: true });
  assert.doesNotMatch(html, /plantuml-block-loading/);
  assert.doesNotMatch(html, />Source</);
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /dangerouslySetInnerHTML/);
});

test("PlantUmlBlock keeps source visible during streaming", () => {
  const html = renderPlantUml({ code: "@startuml\nAlice -> Bob\n@enduml", lang: "puml", defaultPreview: true, isStreaming: true });
  assert.doesNotMatch(html, /plantuml-block-loading/);
  assert.doesNotMatch(html, /disabled/);
  assert.doesNotMatch(html, />Preview</);
  assert.match(html, /Alice -&gt; Bob/);
});
