"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { PendingSubagentReport } from "@/hooks/useAgentSession";

/**
 * The bubble above the composer naming the background subagent results this session has not
 * read. The runtime never delivers them on its own: the user sends the aggregated status
 * report from here (one click), or reads a result in chat with get_subagent_result, either of
 * which clears the pending list via the session's `subagent_reports` event.
 */
export function PendingSubagentReports({ reports, onSend }: {
  reports: PendingSubagentReport[];
  onSend: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  if (reports.length === 0) return null;
  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onSend();
    } finally {
      // The chip stays until the server's `subagent_reports` event clears it; a failed send
      // leaves it in place and is reported by the hook's own notice.
      setSending(false);
    }
  };
  return (
    <div className="pending-subagent-reports" role="status">
      <div className="pending-subagent-reports-body">
        <span className="pending-subagent-reports-title">
          {reports.length === 1 ? t("subagentReports.pendingOne") : t("subagentReports.pending", { count: reports.length })}
        </span>
        <ul className="pending-subagent-reports-list">
          {reports.map((report) => (
            <li key={`${report.sessionId}:${report.completedAt ?? ""}`} className="pending-subagent-reports-row">
              <span className="pending-subagent-reports-name">
                {report.description || report.profile}
                {report.resumed ? ` (${t("subagentReports.resumed")})` : ""}
              </span>
              <span className="pending-subagent-reports-status">{report.status}</span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="pending-subagent-reports-send"
        disabled={sending}
        onClick={() => void send()}
      >
        {t("subagentReports.send")}
      </button>
    </div>
  );
}
