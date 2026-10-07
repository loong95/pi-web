"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useFileBrowserPreferences } from "@/lib/file-browser-preferences";
import { ConfigButton, ConfigField } from "./SettingsUi";

/**
 * Settings › Experimental: paths the `@` file index leaves out. The list is
 * stored on the server (`~/.pi/agent/file-browser.json`), so the chat input's
 * `@` completions read one answer in every browser.
 *
 * The file tree's own "show ignored files" switch is upstream's (#1092): it
 * lives in the files tab's head and is kept per browser.
 *
 * The pattern list is saved on blur or with the button, never per keystroke:
 * a half-typed pattern must not filter the index.
 */
export function FileBrowserSettings() {
  const { t } = useI18n();
  const { preferences, loaded, loadFailed, save } = useFileBrowserPreferences();
  const [patternsText, setPatternsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The text is only seeded once, so a save that echoes back a normalized list
  // does not fight the caret while the operator keeps typing.
  const seededRef = useRef(false);

  useEffect(() => {
    if (!loaded || seededRef.current) return;
    seededRef.current = true;
    setPatternsText(preferences.searchExclude.join("\n"));
  }, [loaded, preferences.searchExclude]);

  const errorDetail = (cause: unknown) => (
    cause instanceof Error && cause.message.trim() ? cause.message.trim() : t("i18n.unknown")
  );

  const savePatterns = () => {
    setError(null);
    setSaving(true);
    setSaved(false);
    void save({ searchExclude: patternsText.split("\n") })
      .then((value) => {
        seededRef.current = true;
        setPatternsText(value.searchExclude.join("\n"));
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
      })
      .catch((cause) => setError(t("settings.fileBrowsingSaveFailed", { message: errorDetail(cause) })))
      .finally(() => setSaving(false));
  };

  // A failed load shows defaults, which must never look like stored settings.
  useEffect(() => {
    if (loadFailed) setError(t("settings.fileBrowsingLoadFailed"));
  }, [loadFailed, t]);

  const dirty = patternsText.split("\n").map((line) => line.trim()).filter(Boolean).join("\n")
    !== preferences.searchExclude.join("\n");

  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("settings.fileBrowsing")}</h3>
      <p className="settings-general-description">{t("settings.searchExcludeDescription")}</p>

      <ConfigField label={t("settings.searchExclude")}>
        <textarea
          aria-label={t("settings.searchExclude")}
          value={patternsText}
          disabled={!loaded || saving}
          placeholder={t("settings.searchExcludePlaceholder")}
          onChange={(event) => setPatternsText(event.target.value)}
          onBlur={() => { if (dirty) savePatterns(); }}
          rows={5}
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: 9,
            border: "1px solid var(--border)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.5,
            resize: "vertical",
          }}
        />
      </ConfigField>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
        <ConfigButton variant="primary" size="small" disabled={!loaded || saving || !dirty} onClick={savePatterns}>
          {t("agents.save")}
        </ConfigButton>
        {saved && <span role="status" style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("i18n.saved")}</span>}
        {error && <span role="alert" style={{ fontSize: 11, color: "#f87171" }}>{error}</span>}
      </div>
    </section>
  );
}
