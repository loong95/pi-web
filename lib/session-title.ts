import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SessionTitleModelRef } from "./session-title-model";

const TITLE_TIMEOUT_MS = 90_000;
const MAX_TITLE_LENGTH = 80;

const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;

export interface GeneratedSessionTitle {
  title: string;
  /** Model that produced the title. */
  model: { provider: string; modelId: string };
  /** Set when a configured title model was unusable and the session model ran instead. */
  modelFallback?: { requested: SessionTitleModelRef };
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * Why automatic naming did not run. Automatic naming only ever names a session
 * once, right after its first prompt, and never overwrites a name the user set.
 */
export type SessionTitleSkipReason =
  | "disabled"
  | "already-named"
  | "no-user-message"
  | "not-first-message";

export function resolveAutoTitleSkipReason(input: {
  enabled: boolean;
  sessionName?: string | null;
  userMessages: number;
}): SessionTitleSkipReason | null {
  if (!input.enabled) return "disabled";
  if (input.sessionName?.trim()) return "already-named";
  if (input.userMessages < 1) return "no-user-message";
  if (input.userMessages > 1) return "not-first-message";
  return null;
}

function createShadowTools(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async () => {
      throw new Error("Tools cannot be executed while generating a session title");
    },
  }));
}

/**
 * Build a temporary Agent configuration whose provider-facing prefix matches
 * the source Agent. Tool implementations are replaced without changing their
 * names, descriptions, or schemas, so a naming run cannot mutate the project.
 *
 * Overrides exist for a configured title model: with one the request no longer
 * shares the source model's cache prefix, but it still sends the same system
 * prompt, tools, and messages.
 */
export function buildSessionTitleAgentOptions(
  source: Agent,
  overrides: SessionTitleAgentOverrides = {},
): AgentOptions {
  const state = source.state;
  return {
    initialState: {
      systemPrompt: state.systemPrompt,
      model: overrides.model ?? state.model,
      thinkingLevel: overrides.thinkingLevel ?? state.thinkingLevel,
      tools: createShadowTools(state.tools),
      messages: state.messages,
    },
    convertToLlm: source.convertToLlm,
    transformContext: source.transformContext,
    streamFn: source.streamFunction,
    getApiKey: source.getApiKey,
    onPayload: source.onPayload,
    onResponse: source.onResponse,
    steeringMode: source.steeringMode,
    followUpMode: source.followUpMode,
    sessionId: source.sessionId,
    thinkingBudgets: source.thinkingBudgets,
    transport: source.transport,
    maxRetryDelayMs: source.maxRetryDelayMs,
    toolExecution: source.toolExecution,
  };
}

/**
 * A running source session usually ends in the user message currently being
 * answered. Fold the title request into a copy of that message so the title
 * request does not send two consecutive user messages to the provider.
 */
export function appendTitleRequestToTrailingUser(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") return messages;

  const content = typeof lastMessage.content === "string"
    ? `${lastMessage.content}\n\n${TITLE_PROMPT}`
    : [...lastMessage.content, { type: "text" as const, text: TITLE_PROMPT }];

  return [
    ...messages.slice(0, -1),
    { ...lastMessage, content },
  ];
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

export function parseGeneratedSessionTitle(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // Fall back to plain-text cleanup below.
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }

  const characters = Array.from(value);
  if (characters.length > MAX_TITLE_LENGTH) {
    value = characters.slice(0, MAX_TITLE_LENGTH).join("").trim();
  }
  return value;
}

interface TitleModelRuntime {
  getModel?: (provider: string, modelId: string) => Model<Api> | undefined;
  refresh?: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
  hasConfiguredAuth?: (provider: string) => boolean;
}

/**
 * Resolve a configured title model through the source session's runtime, which
 * already knows pi's model catalog and credentials.
 *
 * Best effort by design: a stale id or a provider whose credentials were removed
 * makes the caller fall back to the session's own model. A misconfigured title
 * model must never make the manual button fail, let alone the chat.
 */
async function resolveTitleModel(source: AgentSession, ref: SessionTitleModelRef): Promise<Model<Api> | undefined> {
  const runtime = (source as unknown as { modelRuntime?: TitleModelRuntime }).modelRuntime;
  if (!runtime?.getModel) return undefined;

  let model = runtime.getModel(ref.provider, ref.modelId);
  if (!model && runtime.refresh) {
    await runtime.refresh({ allowNetwork: false }).catch(() => {});
    model = runtime.getModel(ref.provider, ref.modelId);
  }
  if (!model) return undefined;
  if (runtime.hasConfiguredAuth && !runtime.hasConfiguredAuth(ref.provider)) return undefined;
  return model;
}

function getAssistantResult(
  agent: Agent,
  historyLength: number,
  titleModel: { provider: string; id: string },
  fallback: GeneratedSessionTitle["modelFallback"],
): GeneratedSessionTitle {
  const generatedMessages = agent.state.messages.slice(historyLength);
  for (let i = generatedMessages.length - 1; i >= 0; i--) {
    const message = generatedMessages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "The title model request failed");
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) continue;
    return {
      title: parseGeneratedSessionTitle(text),
      model: { provider: titleModel.provider, modelId: titleModel.id },
      ...(fallback ? { modelFallback: fallback } : {}),
      ...(message.usage ? {
        usage: {
          input: message.usage.input,
          output: message.usage.output,
          cacheRead: message.usage.cacheRead,
          cacheWrite: message.usage.cacheWrite,
          total: message.usage.totalTokens,
        },
      } : {}),
    };
  }
  throw new Error("The model did not return a session title");
}

export function sanitizeTitleMessages(messages: AgentMessage[]): AgentMessage[] {
  const sanitized: AgentMessage[] = [];
  let expectedToolResultIds: Set<string> | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message.role === "assistant") {
      const followingToolResultIds = new Set<string>();
      for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
        const resultMessage = messages[resultIndex];
        if (resultMessage.role !== "toolResult") break;
        followingToolResultIds.add(resultMessage.toolCallId);
      }

      expectedToolResultIds = new Set<string>();
      const content = message.content.filter((block) => {
        if (block.type !== "toolCall") return true;
        if (!followingToolResultIds.has(block.id)) return false;
        expectedToolResultIds!.add(block.id);
        return true;
      });

      if (content.length > 0) {
        sanitized.push({ ...message, content });
      }
      continue;
    }

    if (message.role === "toolResult") {
      if (expectedToolResultIds?.delete(message.toolCallId)) {
        sanitized.push(message);
      }
      continue;
    }

    expectedToolResultIds = undefined;
    sanitized.push(message);
  }

  return sanitized;
}

export interface SessionTitleOptions {
  /** Generate the title with this model instead of the model the session is using. */
  model?: SessionTitleModelRef;
}

export interface SessionTitleAgentOverrides {
  model?: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

export async function generateSessionTitle(
  source: AgentSession,
  options: SessionTitleOptions = {},
): Promise<GeneratedSessionTitle> {
  const sourceAgent = source.agent;
  await sourceAgent.waitForIdle();

  const requestedModel = options.model;
  const targetModel = requestedModel ? await resolveTitleModel(source, requestedModel) : undefined;
  const modelFallback = requestedModel && !targetModel ? { requested: requestedModel } : undefined;

  const sanitizedMessages = sanitizeTitleMessages(sourceAgent.state.messages);
  const historyLength = sanitizedMessages.length;
  if (!sanitizedMessages.some(
    (message) => message.role === "user" || message.role === "compactionSummary",
  )) {
    throw new Error("The session has no user messages to name");
  }

  const titleOptions = buildSessionTitleAgentOptions(
    sourceAgent,
    targetModel
      // A title is a short extraction task, so an override never inherits the
      // session's thinking level: use the target model's cheapest level.
      ? { model: targetModel, thinkingLevel: clampThinkingLevel(targetModel, "off") }
      : {},
  );
  titleOptions.initialState!.messages = sanitizedMessages;
  const continuesFromTrailingUser = sanitizedMessages.at(-1)?.role === "user";
  if (continuesFromTrailingUser) {
    titleOptions.initialState!.messages = appendTitleRequestToTrailingUser(sanitizedMessages);
  }

  const temporaryAgent = new Agent(titleOptions);
  const runPromise = continuesFromTrailingUser
    ? temporaryAgent.continue()
    : temporaryAgent.prompt(TITLE_PROMPT);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          temporaryAgent.abort();
          reject(new Error("Session title generation timed out"));
        }, TITLE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    temporaryAgent.abort();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  // The temporary agent's own state is the authority on which model ran: it
  // holds the override after resolution and cannot be undefined on this path.
  return getAssistantResult(temporaryAgent, historyLength, temporaryAgent.state.model, modelFallback);
}
