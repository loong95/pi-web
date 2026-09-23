"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  isWorktreeSessionScopeEnabled,
  setWorktreeSessionScopeEnabled,
} from "@/lib/worktree-session-scope";
import { PlantUmlSettings } from "./PlantUmlSettings";
import { SessionTitleSettings } from "./SessionTitleSettings";
import { ConfigSwitch } from "./SettingsUi";

export function ExperimentalSettings({ cwd = null }: { cwd?: string | null }) {
  const { t } = useI18n();
  const [worktreeSessionScope, setWorktreeSessionScope] = useState(false);

  useEffect(() => {
    setWorktreeSessionScope(isWorktreeSessionScopeEnabled());
  }, []);

  return (
    <div className="settings-general">
      <h2 className="settings-general-title">{t("settings.experimental")}</h2>
      <p className="settings-general-description">{t("settings.experimentalDescription")}</p>

      <section className="settings-general-section">
        <h3 className="settings-general-heading">{t("settings.worktreeSessions")}</h3>
        <p className="settings-general-description">{t("settings.onlyCurrentWorktreeDescription")}</p>
        <div className="settings-shell-option">
          <span>{t("settings.onlyCurrentWorktree")}</span>
          <ConfigSwitch
            checked={worktreeSessionScope}
            label={t("settings.onlyCurrentWorktree")}
            onChange={(enabled) => {
              setWorktreeSessionScopeEnabled(enabled);
              setWorktreeSessionScope(enabled);
            }}
          />
        </div>
      </section>

      <SessionTitleSettings cwd={cwd} />

      <PlantUmlSettings />
    </div>
  );
}
