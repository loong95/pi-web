"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelsData } from "@/lib/models-cache";
import { parseSessionTitleModelRef, type SessionTitleModelRef } from "@/lib/session-title-model";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";
import { ConfigSwitch } from "./SettingsUi";

interface SessionTitleSettingsResponse {
  autoEnabled?: unknown;
  model?: unknown;
  error?: unknown;
}

/**
 * Experimental auto session title: the toggle and the model used for naming.
 * Every failure is reported inline and rolled back, so a broken setting can
 * never block the rest of the settings tab or the chat itself.
 */
export function SessionTitleSettings({ cwd = null }: { cwd?: string | null }) {
  const { t } = useI18n();
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [model, setModel] = useState<SessionTitleModelRef | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelsData["modelList"]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errorDetail = useCallback((cause: unknown) => (
    cause instanceof Error && cause.message.trim() ? cause.message.trim() : t("i18n.unknown")
  ), [t]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/session-title/settings", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json() as SessionTitleSettingsResponse;
        if (!response.ok || typeof data.autoEnabled !== "boolean") {
          throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
        }
        setAutoEnabled(data.autoEnabled);
        setModel(parseSessionTitleModelRef(data.model));
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(t("settings.autoTitleLoadFailed", { message: errorDetail(cause) }));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [errorDetail, t]);

  // The title settings are global, so only the model list follows the project.
  useEffect(() => {
    const controller = new AbortController();
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    void (async () => {
      try {
        const response = await fetch(`/api/models${query}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json() as Partial<ModelsData>;
        if (response.ok && Array.isArray(data.modelList)) setModelOptions(data.modelList);
      } catch {
        // Selecting a model is optional; the stored value stays effective when
        // the catalogue cannot be listed.
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const options = useMemo<ModelSelectorOption[]>(
    () => modelOptions.map((entry) => ({ provider: entry.provider, modelId: entry.id, name: entry.name })),
    [modelOptions],
  );

  const save = useCallback(async (
    patch: { autoEnabled?: boolean; model?: SessionTitleModelRef | null },
    rollback: () => void,
  ) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/session-title/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => ({})) as SessionTitleSettingsResponse;
      if (!response.ok || typeof data.autoEnabled !== "boolean") {
        throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
      }
      setAutoEnabled(data.autoEnabled);
      setModel(parseSessionTitleModelRef(data.model));
    } catch (cause) {
      rollback();
      setError(t("settings.autoTitleSaveFailed", { message: errorDetail(cause) }));
    } finally {
      setSaving(false);
    }
  }, [errorDetail, t]);

  const toggle = (next: boolean) => {
    const previous = autoEnabled;
    setAutoEnabled(next);
    void save({ autoEnabled: next }, () => setAutoEnabled(previous));
  };

  const selectModel = (provider: string, modelId: string) => {
    const previous = model;
    const next = { provider, modelId };
    setModel(next);
    void save({ model: next }, () => setModel(previous));
  };

  const clearModel = () => {
    const previous = model;
    setModel(null);
    void save({ model: null }, () => setModel(previous));
  };

  return (
    <section className="settings-general-section" aria-busy={loading || undefined}>
      <h3 className="settings-general-heading">{t("settings.autoTitle")}</h3>
      <p className="settings-general-description">{t("settings.autoTitleDescription")}</p>

      <div className="settings-shell-option">
        <span>{t("settings.autoTitleEnabled")}</span>
        <ConfigSwitch
          checked={autoEnabled}
          loading={loading}
          disabled={saving}
          label={t("settings.autoTitleEnabled")}
          onChange={toggle}
        />
      </div>

      <div className="settings-session-title-model">
        <span className="settings-session-title-model-label">{t("settings.autoTitleModel")}</span>
        <ModelSelector
          options={options}
          value={model}
          onChange={selectModel}
          onClear={clearModel}
          emptyLabel={loading ? t("settings.autoTitleModelLoading") : t("settings.autoTitleModelSession")}
          selectedLabel={model && options.length > 0 && !options.some((option) => (
            option.provider === model.provider && option.modelId === model.modelId
          ))
            ? t("settings.autoTitleModelUnavailable", { model: `${model.provider}/${model.modelId}` })
            : undefined}
          disabled={loading || saving}
          ariaLabel={t("settings.autoTitleModel")}
          variant="field"
          placement="auto"
        />
        <p className="settings-general-description">{t("settings.autoTitleModelDescription")}</p>
      </div>

      {error && <p role="alert" className="settings-general-error">{error}</p>}
    </section>
  );
}
