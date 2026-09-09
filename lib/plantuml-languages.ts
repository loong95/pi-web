export const PLANTUML_LANGUAGES = new Set(["plantuml", "puml", "wsd"]);

/** Supported fenced-code labels, matching PlantUML's common Markdown aliases. */
export function isPlantUmlLanguage(language: string): boolean {
  return PLANTUML_LANGUAGES.has(language.toLowerCase());
}
