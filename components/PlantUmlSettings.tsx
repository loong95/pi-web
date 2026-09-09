"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { announcePlantUmlSettingsChanged } from "@/lib/plantuml-client";
import { ConfigButton } from "./SettingsUi";

interface PlantUmlSettingsResponse {
  serverUrl?: unknown;
  error?: unknown;
}

export function PlantUmlSettings() {
  const { t } = useI18n();
  const [serverUrl, setServerUrl] = useState("");
  const [savedUrl, setSavedUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<"success" | "failed" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/plantuml/settings", { cache: "no-store", signal: controller.signal });
        const data = await response.json() as PlantUmlSettingsResponse;
        if (!response.ok || typeof data.serverUrl !== "string") {
          throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
        }
        setServerUrl(data.serverUrl);
        setSavedUrl(data.serverUrl);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const save = async (nextUrl = serverUrl): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await fetch("/api/plantuml/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverUrl: nextUrl }),
      });
      const data = await response.json() as PlantUmlSettingsResponse;
      if (!response.ok || typeof data.serverUrl !== "string") {
        throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
      }
      setServerUrl(data.serverUrl);
      setSavedUrl(data.serverUrl);
      announcePlantUmlSettingsChanged();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (serverUrl !== savedUrl && !(await save())) return;
    if (!serverUrl.trim()) return;
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const response = await fetch("/api/plantuml/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "@startuml\nAlice -> Bob: test\n@enduml" }),
      });
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("image/svg+xml")) {
        const data = await response.json().catch(() => null) as PlantUmlSettingsResponse | null;
        throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
      }
      setTestResult("success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="settings-general-section" aria-busy={loading || undefined}>
      <h3 className="settings-general-heading">{t("settings.plantUml")}</h3>
      <p className="settings-general-description">{t("settings.plantUmlDescription")}</p>
      <div className="settings-plantuml-controls">
        <label htmlFor="settings-plantuml-server-url">{t("settings.plantUmlServerUrl")}</label>
        <input
          id="settings-plantuml-server-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://plantuml.example.com/plantuml"
          value={serverUrl}
          disabled={loading || saving}
          onChange={(event) => { setServerUrl(event.target.value); setTestResult(null); }}
        />
        <div className="settings-plantuml-actions">
          <ConfigButton variant="primary" disabled={loading || saving || serverUrl === savedUrl} onClick={() => void save()}>
            {saving ? t("i18n.saving") : t("i18n.save")}
          </ConfigButton>
          <ConfigButton variant="secondary" disabled={loading || saving || testing || !serverUrl.trim()} onClick={() => void testConnection()}>
            {testing ? t("settings.testingPlantUml") : t("settings.testPlantUmlConnection")}
          </ConfigButton>
          <ConfigButton variant="ghost" disabled={loading || saving || !serverUrl} onClick={() => void save("")}>
            {t("settings.clearPlantUmlServer")}
          </ConfigButton>
        </div>
      </div>
      {testResult === "success" && <p className="settings-plantuml-success">{t("i18n.connected")}</p>}
      {error && <p role="alert" className="settings-general-error">{error}</p>}
    </section>
  );
}
