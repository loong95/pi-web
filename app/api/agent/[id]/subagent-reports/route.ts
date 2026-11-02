import { NextResponse } from "next/server";
import { deliverSubagentReports, getPendingSubagentReports } from "@/lib/rpc-manager";

// GET /api/agent/[id]/subagent-reports - the background subagent results the session has not
// read yet. The page's chip above the composer shows this after a reload or a session switch;
// while the page is connected, the same list arrives on the event stream (`subagent_reports`).
// Never starts a wrapper: an unknown or closed session reports an empty list.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reports = getPendingSubagentReports(id).map(toChipRow);
  return NextResponse.json({ reports }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/agent/[id]/subagent-reports - the user clicked the chip's send button: one aggregated
// status message reaches the session now (a followUp while it runs, a fresh turn when idle).
// The runtime never sends on its own; this is the only delivery path. Returns the runs named.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const delivered = await deliverSubagentReports(id);
    return NextResponse.json({
      success: true,
      reports: delivered.map(toChipRow),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

/** What the chip shows per report: identity and state, never the result text. */
function toChipRow(run: {
  sessionId: string;
  profile: string;
  description: string;
  status: string;
  resumed?: boolean;
  completedAt?: string;
}) {
  return {
    sessionId: run.sessionId,
    profile: run.profile,
    description: run.description,
    status: run.status,
    resumed: run.resumed,
    completedAt: run.completedAt,
  };
}
