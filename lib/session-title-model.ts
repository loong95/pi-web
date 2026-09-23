/**
 * Provider/model pair a session title is generated with. Kept free of Node
 * imports so the settings UI and the server share one parser and one type.
 */
export interface SessionTitleModelRef {
  provider: string;
  modelId: string;
}

/** Accept only a complete `{ provider, modelId }` pair; anything else means "follow the session". */
export function parseSessionTitleModelRef(value: unknown): SessionTitleModelRef | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { provider?: unknown; modelId?: unknown };
  if (typeof candidate.provider !== "string" || typeof candidate.modelId !== "string") return null;
  const provider = candidate.provider.trim();
  const modelId = candidate.modelId.trim();
  return provider && modelId ? { provider, modelId } : null;
}
