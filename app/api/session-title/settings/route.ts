import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { parseSessionTitleModelRef } from "@/lib/session-title-model";
import {
  readSessionTitleSettings,
  writeSessionTitleSettings,
  type SessionTitleSettingsPatch,
} from "@/lib/session-title-settings";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  try {
    return NextResponse.json(readSessionTitleSettings());
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { autoEnabled?: unknown; model?: unknown };
    if (body.autoEnabled === undefined && body.model === undefined) {
      return NextResponse.json({ error: "autoEnabled or model is required" }, { status: 400 });
    }
    if (body.autoEnabled !== undefined && typeof body.autoEnabled !== "boolean") {
      return NextResponse.json({ error: "autoEnabled must be a boolean" }, { status: 400 });
    }

    const patch: SessionTitleSettingsPatch = {};
    if (body.autoEnabled !== undefined) patch.autoEnabled = body.autoEnabled;
    if (body.model !== undefined) {
      const model = parseSessionTitleModelRef(body.model);
      if (body.model !== null && model === null) {
        return NextResponse.json({ error: "model must be null or { provider, modelId }" }, { status: 400 });
      }
      patch.model = model;
    }

    return NextResponse.json(writeSessionTitleSettings(patch));
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
