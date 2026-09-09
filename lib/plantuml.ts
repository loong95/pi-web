import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export const PLANTUML_MAX_SOURCE_LENGTH = 256 * 1024;
export const PLANTUML_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PLANTUML_FETCH_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "127.0.0.1"]);

export interface PlantUmlSettings {
  serverUrl: string;
}

type StoredPlantUmlSettings = Record<string, unknown> & {
  serverUrl?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPlantUmlSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "plantuml.json");
}

function readStoredSettings(settingsPath: string): StoredPlantUmlSettings {
  if (!existsSync(settingsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("Invalid PlantUML settings: expected an object");
  return parsed as StoredPlantUmlSettings;
}

export function readPlantUmlSettings(
  settingsPath = getPlantUmlSettingsPath(),
): PlantUmlSettings {
  const stored = readStoredSettings(settingsPath);
  return { serverUrl: typeof stored.serverUrl === "string" ? stored.serverUrl : "" };
}

export function writePlantUmlSettings(
  serverUrl: string,
  settingsPath = getPlantUmlSettingsPath(),
): PlantUmlSettings {
  const stored = readStoredSettings(settingsPath);
  const parent = dirname(settingsPath);
  mkdirSync(parent, { recursive: true });
  writePrivateFileAtomicSync(settingsPath, JSON.stringify({
    ...stored,
    version: 1,
    serverUrl,
  }, null, 2));
  return { serverUrl };
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return LOOPBACK_HOSTS.has(normalized)
    || (isIP(normalized) === 4 && normalized.startsWith("127."))
    || normalized.startsWith("::ffff:127.")
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(normalized);
}

/** Validate and normalize the operator-provided PlantUML Server base URL. */
export function normalizePlantUmlServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("PlantUML Server URL must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PlantUML Server URL must use HTTPS (or HTTP for loopback)");
  }
  if (parsed.username || parsed.password) {
    throw new Error("PlantUML Server URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("PlantUML Server URL must not contain a query or fragment");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("HTTP PlantUML servers are allowed only on loopback hosts");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function encode6bit(value: number): string {
  if (value < 10) return String.fromCharCode(48 + value);
  if (value < 36) return String.fromCharCode(65 + value - 10);
  if (value < 62) return String.fromCharCode(97 + value - 36);
  if (value === 62) return "-";
  if (value === 63) return "_";
  throw new Error("Invalid PlantUML six-bit value");
}

function append3Bytes(first: number, second: number, third: number): string {
  return encode6bit(first >> 2)
    + encode6bit(((first & 0x3) << 4) | (second >> 4))
    + encode6bit(((second & 0xf) << 2) | (third >> 6))
    + encode6bit(third & 0x3f);
}

/** PlantUML's standard UTF-8 -> raw DEFLATE -> six-bit URL encoding. */
export function encodePlantUml(source: string): string {
  const compressed = deflateRawSync(Buffer.from(source, "utf8"));
  let encoded = "";
  for (let index = 0; index < compressed.length; index += 3) {
    encoded += append3Bytes(
      compressed[index],
      compressed[index + 1] ?? 0,
      compressed[index + 2] ?? 0,
    );
  }
  return encoded;
}

export function buildPlantUmlSvgUrl(serverUrl: string, source: string): string {
  const base = normalizePlantUmlServerUrl(serverUrl);
  if (!base) throw new Error("PlantUML Server is not configured");
  const separator = base.endsWith("/") ? "" : "/";
  return `${base}${separator}svg/${encodePlantUml(source)}`;
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > PLANTUML_MAX_RESPONSE_BYTES) {
    throw new Error("PlantUML response is too large");
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PLANTUML_MAX_RESPONSE_BYTES) throw new Error("PlantUML response is too large");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > PLANTUML_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("PlantUML response is too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface RenderPlantUmlOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function renderPlantUml(
  source: string,
  serverUrl: string,
  options: RenderPlantUmlOptions = {},
): Promise<Uint8Array> {
  if (!source.trim()) throw new Error("PlantUML source is required");
  if (source.length > PLANTUML_MAX_SOURCE_LENGTH) throw new Error("PlantUML source is too large");

  const controller = new AbortController();
  const abortForCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", abortForCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? PLANTUML_FETCH_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(buildPlantUmlSvgUrl(serverUrl, source), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "image/svg+xml" },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`PlantUML Server returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/svg+xml")) {
      throw new Error("PlantUML Server did not return SVG");
    }
    return await readResponseBytes(response);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("PlantUML Server request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortForCaller);
  }
}
