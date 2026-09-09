import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  normalizePlantUmlServerUrl,
  readPlantUmlSettings,
  writePlantUmlSettings,
} from "@/lib/plantuml";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  try {
    return NextResponse.json(readPlantUmlSettings());
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
    const body = await req.json() as { serverUrl?: unknown };
    if (typeof body.serverUrl !== "string") {
      return NextResponse.json({ error: "serverUrl must be a string" }, { status: 400 });
    }
    const serverUrl = normalizePlantUmlServerUrl(body.serverUrl);
    return NextResponse.json(writePlantUmlSettings(serverUrl));
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
