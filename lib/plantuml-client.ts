export const PLANTUML_SETTINGS_CHANGED_EVENT = "pi-web:plantuml-settings-changed";

/** Notify mounted diagram blocks that the global PlantUML configuration changed. */
export function announcePlantUmlSettingsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PLANTUML_SETTINGS_CHANGED_EVENT));
  }
}
