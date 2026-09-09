import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildPlantUmlSvgUrl,
  encodePlantUml,
  normalizePlantUmlServerUrl,
  renderPlantUml,
} = await jiti.import("./plantuml.ts");
const { isPlantUmlLanguage } = await jiti.import("./plantuml-languages.ts");

const source = "@startuml\nAlice -> Bob: test\n@enduml";

test("normalizes safe PlantUML Server base URLs", () => {
  assert.equal(normalizePlantUmlServerUrl(" https://uml.example.test/plantuml/ "), "https://uml.example.test/plantuml");
  assert.equal(normalizePlantUmlServerUrl("http://localhost:8080/plantuml/"), "http://localhost:8080/plantuml");
  assert.equal(normalizePlantUmlServerUrl("http://[::1]:8080/plantuml"), "http://[::1]:8080/plantuml");
  assert.equal(normalizePlantUmlServerUrl("http://[::ffff:127.0.0.1]:8080/plantuml"), "http://[::ffff:7f00:1]:8080/plantuml");
  assert.equal(normalizePlantUmlServerUrl(""), "");
});

test("rejects unsafe PlantUML Server URLs", () => {
  for (const url of [
    "http://uml.example.test/plantuml",
    "http://[::2]/plantuml",
    "ftp://localhost/plantuml",
    "https://user:secret@uml.example.test/plantuml",
    "https://uml.example.test/plantuml?token=secret",
    "https://uml.example.test/plantuml#fragment",
  ]) {
    assert.throws(() => normalizePlantUmlServerUrl(url), url);
  }
});

test("encodes PlantUML with the official raw-DEFLATE six-bit alphabet", () => {
  assert.equal(encodePlantUml(source), "SoWkIImgAStDuNBCoKnELT2rKt3AJx9IA4ajBk5oICrBAStD0G00");
  assert.equal(
    buildPlantUmlSvgUrl("https://uml.example.test", source),
    "https://uml.example.test/svg/SoWkIImgAStDuNBCoKnELT2rKt3AJx9IA4ajBk5oICrBAStD0G00",
  );
  assert.equal(
    buildPlantUmlSvgUrl("https://uml.example.test/plantuml/", source),
    "https://uml.example.test/plantuml/svg/SoWkIImgAStDuNBCoKnELT2rKt3AJx9IA4ajBk5oICrBAStD0G00",
  );
});

test("recognizes every supported PlantUML fence language", () => {
  for (const language of ["plantuml", "puml", "wsd", "PLANTUML"]) assert.equal(isPlantUmlLanguage(language), true);
  assert.equal(isPlantUmlLanguage("mermaid"), false);
});

test("proxies only successful SVG responses", async () => {
  const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
  const result = await renderPlantUml(source, "https://uml.example.test/plantuml", {
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/svg\//);
      assert.equal(init.redirect, "manual");
      return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
    },
  });
  assert.equal(new TextDecoder().decode(result), svg);

  await assert.rejects(
    renderPlantUml(source, "https://uml.example.test/plantuml", {
      fetchImpl: async () => new Response("not svg", { headers: { "content-type": "text/html" } }),
    }),
    /did not return SVG/,
  );
  await assert.rejects(
    renderPlantUml(source, "https://uml.example.test/plantuml", {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
    }),
    /HTTP 302/,
  );
});

test("rejects PlantUML responses that exceed the configured size limit", async () => {
  await assert.rejects(
    renderPlantUml(source, "https://uml.example.test/plantuml", {
      fetchImpl: async () => new Response("small", {
        headers: { "content-type": "image/svg+xml", "content-length": String(2 * 1024 * 1024 + 1) },
      }),
    }),
    /response is too large/,
  );

  const oversizedBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      controller.close();
    },
  });
  await assert.rejects(
    renderPlantUml(source, "https://uml.example.test/plantuml", {
      fetchImpl: async () => new Response(oversizedBody, { headers: { "content-type": "image/svg+xml" } }),
    }),
    /response is too large/,
  );
});

test("times out PlantUML Server requests", async () => {
  await assert.rejects(
    renderPlantUml(source, "https://uml.example.test/plantuml", {
      timeoutMs: 1,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    }),
    /timed out/,
  );
});
