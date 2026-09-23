import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  generateSessionTitle,
  resolveAutoTitleSkipReason,
  type SessionTitleSkipReason,
} from "@/lib/session-title";
import { readSessionTitleSettingsSafely } from "@/lib/session-title-settings";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

type AutoNameTrigger = "auto" | "manual";

/**
 * The background trigger posts `{ trigger: "auto" }`; the settings button sends
 * no body. Anything unparsable counts as an explicit manual request, so a stale
 * client can never turn the user's own action into a disabled no-op.
 */
async function readTrigger(req: Request): Promise<AutoNameTrigger> {
  const text = await req.text().catch(() => "");
  if (!text.trim()) return "manual";
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object"
      && (parsed as { trigger?: unknown }).trigger === "auto"
      ? "auto"
      : "manual";
  } catch {
    return "manual";
  }
}

function skipped(reason: SessionTitleSkipReason) {
  return NextResponse.json({ skipped: reason });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const trigger = await readTrigger(req);

  // Read the settings before touching the session. A disabled feature must not
  // start an AgentSession, and an unreadable settings file disables background
  // naming instead of failing the request.
  const settings = readSessionTitleSettingsSafely();
  if (trigger === "auto" && !settings.autoEnabled) return skipped("disabled");

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const inner = session.inner as unknown as AgentSession;

    if (trigger === "auto") {
      // The browser only knows that a prompt settled; the session decides whether
      // it is still unnamed and has exactly one user message.
      const reason = resolveAutoTitleSkipReason({
        enabled: settings.autoEnabled,
        sessionName: inner.sessionManager.getSessionName(),
        userMessages: inner.getSessionStats().userMessages,
      });
      if (reason) return skipped(reason);
    }

    const result = await generateSessionTitle(inner, {
      ...(settings.model ? { model: settings.model } : {}),
    });

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({
      title: result.title,
      model: result.model,
      modelFallback: result.modelFallback ?? null,
      usage: result.usage ?? null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
