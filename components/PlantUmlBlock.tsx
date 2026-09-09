"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { PLANTUML_SETTINGS_CHANGED_EVENT } from "@/lib/plantuml-client";
import { CodeBlock } from "./MermaidBlock";

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

interface PlantUmlBlockProps {
  code: string;
  lang: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
}

type RenderState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string }
  | { key: string; status: "ready"; imageUrl: string };

/** Renders PlantUML through Pi Web's configured server-side proxy. */
export function PlantUmlBlock({ code, lang, isStreaming, defaultPreview = false }: PlantUmlBlockProps) {
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [renderState, setRenderState] = useState<RenderState | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imageUrlRef = useRef<string | null>(null);
  const currentKey = `${lang}\n${code}`;
  const previewVisible = showPreview && !isStreaming && serverEnabled === true;

  useEffect(() => {
    let controller: AbortController | null = null;
    const loadSettings = () => {
      controller?.abort();
      const activeController = new AbortController();
      controller = activeController;
      void fetch("/api/plantuml/settings", { cache: "no-store", signal: activeController.signal })
        .then(async (response) => {
          const body = await response.json() as { serverUrl?: unknown };
          if (!response.ok || typeof body.serverUrl !== "string") throw new Error("Unable to load PlantUML settings");
          setServerEnabled(Boolean(body.serverUrl));
        })
        .catch(() => {
          if (!activeController.signal.aborted) setServerEnabled(false);
        });
    };
    loadSettings();
    window.addEventListener(PLANTUML_SETTINGS_CHANGED_EVENT, loadSettings);
    return () => {
      controller?.abort();
      window.removeEventListener(PLANTUML_SETTINGS_CHANGED_EVENT, loadSettings);
    };
  }, []);

  useEffect(() => {
    if (!previewVisible) return;

    let cancelled = false;
    const controller = new AbortController();
    let imageUrl: string | null = null;
    setRenderState({ key: currentKey, status: "loading" });
    void (async () => {
      try {
        const response = await fetch("/api/plantuml/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: code }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: unknown } | null;
          throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
        }
        const svg = await response.blob();
        if (svg.type && !svg.type.toLowerCase().startsWith("image/svg+xml")) {
          throw new Error("PlantUML Server did not return SVG");
        }
        imageUrl = URL.createObjectURL(svg);
        if (cancelled) {
          URL.revokeObjectURL(imageUrl);
          return;
        }
        imageUrlRef.current = imageUrl;
        setRenderState({ key: currentKey, status: "ready", imageUrl });
        imageUrl = null;
      } catch (cause) {
        if (!cancelled && !controller.signal.aborted) {
          setRenderState({
            key: currentKey,
            status: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      if (imageUrlRef.current) {
        URL.revokeObjectURL(imageUrlRef.current);
        imageUrlRef.current = null;
      }
    };
  }, [code, currentKey, previewVisible]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!zoomOpen || !dialog) return;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, [zoomOpen]);

  const previewButton = useMemo(() => (
    <button
      type="button"
      onClick={() => setShowPreview((value) => !value)}
      disabled={isStreaming}
      title={isStreaming ? t("i18n.previewAfterStreaming") : (previewVisible ? t("i18n.showPlantUmlSource") : t("i18n.previewPlantUml"))}
      className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {previewVisible ? t("i18n.source") : t("i18n.preview")}
    </button>
  ), [isStreaming, previewVisible, t]);

  if (serverEnabled !== true) {
    return <CodeBlock code={code} lang={lang} isStreaming={isStreaming} />;
  }

  if (!previewVisible) {
    return <CodeBlock code={code} lang={lang} headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const ready = renderState?.key === currentKey && renderState.status === "ready" ? renderState : null;
  const error = renderState?.key === currentKey && renderState.status === "error" ? renderState : null;
  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang}</span>
        <div className="markdown-code-actions">
          {ready && (
            <a
              className="markdown-code-action"
              href={ready.imageUrl}
              download="plantuml-diagram.svg"
              title={`${t("i18n.downloadFile")} (SVG)`}
              aria-label={`${t("i18n.downloadFile")} (SVG)`}
            >SVG</a>
          )}
          {previewButton}
        </div>
      </div>
      {error ? (
        <>
          <div className="plantuml-block plantuml-block-error" role="alert">
            {t("i18n.plantUmlRenderFailed")}: {error.message}
          </div>
          <CodeBlock code={code} lang={lang} />
        </>
      ) : !ready ? (
        <div className="plantuml-block plantuml-block-loading" aria-label={t("i18n.renderingPlantUml")} />
      ) : (
        <>
          <button
            type="button"
            className="plantuml-block plantuml-preview-button"
            title={t("i18n.openPlantUmlViewer")}
            aria-label={t("i18n.openPlantUmlViewer")}
            onClick={() => {
              setZoom(1);
              setZoomOpen(true);
            }}
          >
            {/* SVG is deliberately displayed as an image rather than injected into the document. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={ready.imageUrl} alt={t("i18n.plantUmlDiagram")} />
          </button>
          {zoomOpen && (
            <dialog
              ref={dialogRef}
              className="plantuml-zoom-dialog"
              aria-label={t("i18n.plantUmlViewer")}
              onCancel={(event) => { event.preventDefault(); setZoomOpen(false); }}
              onClick={(event) => { if (event.target === event.currentTarget) setZoomOpen(false); }}
            >
              <div className="plantuml-zoom-toolbar">
                <span>{t("i18n.plantUmlDiagram")}</span>
                <div className="plantuml-zoom-actions">
                  <div className="plantuml-zoom-stepper">
                    <button type="button" onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))} disabled={zoom <= ZOOM_MIN} aria-label={t("i18n.zoomOut")} title={t("i18n.zoomOut")}>−</button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button type="button" onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))} disabled={zoom >= ZOOM_MAX} aria-label={t("i18n.zoomIn")} title={t("i18n.zoomIn")}>+</button>
                  </div>
                  <button type="button" className="plantuml-zoom-icon-button" onClick={() => setZoom(1)} aria-label={t("i18n.fitToWidth")} title={t("i18n.fitToWidth")}>↔</button>
                  <button type="button" className="plantuml-zoom-icon-button" onClick={() => setZoomOpen(false)} aria-label={t("i18n.close")} title={t("i18n.close")}>×</button>
                </div>
              </div>
              <div className="plantuml-zoom-viewport">
                <div className="plantuml-zoom-canvas" style={{ width: `${zoom * 100}%` }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={ready.imageUrl} alt={t("i18n.plantUmlDiagram")} />
                </div>
              </div>
            </dialog>
          )}
        </>
      )}
    </div>
  );
}
