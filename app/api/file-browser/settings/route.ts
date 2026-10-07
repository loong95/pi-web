import { NextResponse } from "next/server";
import {
  readFileBrowserSettings,
  writeFileBrowserSettings,
  type FileBrowserSettingsPatch,
} from "@/lib/file-browser-settings";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// The file explorer's own settings: which paths the `@` index leaves out. Read
// on the server, so the answer is the same in every browser and on every
// device. The tree's own "show ignored files" switch is upstream's and lives
// per browser in `lib/sidebar-prefs.ts`.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  try {
    return NextResponse.json(readFileBrowserSettings());
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
    const body = await req.json() as { searchExclude?: unknown };
    if (body.searchExclude === undefined) {
      return NextResponse.json({ error: "searchExclude is required" }, { status: 400 });
    }

    const patch: FileBrowserSettingsPatch = {};
    if (body.searchExclude !== undefined) {
      if (!Array.isArray(body.searchExclude) || body.searchExclude.some((entry) => typeof entry !== "string")) {
        return NextResponse.json({ error: "searchExclude must be an array of strings" }, { status: 400 });
      }
      patch.searchExclude = body.searchExclude as string[];
    }

    return NextResponse.json(writeFileBrowserSettings(patch));
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
