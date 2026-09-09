import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { PLANTUML_MAX_SOURCE_LENGTH, readPlantUmlSettings, renderPlantUml } from "@/lib/plantuml";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { source?: unknown };
    if (typeof body.source !== "string") {
      return NextResponse.json({ error: "source must be a string" }, { status: 400 });
    }
    if (!body.source.trim()) {
      return NextResponse.json({ error: "PlantUML source is required" }, { status: 400 });
    }
    if (body.source.length > PLANTUML_MAX_SOURCE_LENGTH) {
      return NextResponse.json({ error: "PlantUML source is too large" }, { status: 413 });
    }
    const { serverUrl } = readPlantUmlSettings();
    if (!serverUrl) {
      return NextResponse.json({ error: "PlantUML Server is not configured" }, { status: 503 });
    }
    const svg = await renderPlantUml(body.source, serverUrl, { signal: req.signal });
    // Next's BodyInit typing excludes Uint8Array even though the Fetch standard accepts it.
    const svgBody = svg.buffer.slice(svg.byteOffset, svg.byteOffset + svg.byteLength) as ArrayBuffer;
    return new NextResponse(svgBody, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}
