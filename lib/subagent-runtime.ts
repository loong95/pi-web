import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import {
  subagentStatusNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  resolveSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createSubagentSkillsBinding } from "./subagent-skills";
import { appendSubagentInputFiles, loadSubagentInputFiles, subagentInputLimits } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { createSubagentCodemodeExtension, createSubagentMcpExtensions } from "./builtin-extensions";
import type { McpHost } from "./mcp-host";
import { createSubagentMcpPolicyExtension } from "./mcp-read-only-policy";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { SubagentQueue } from "./subagent-queue";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  waitUntilReady(): Promise<void>;
  /**
   * Connect the session's MCP servers before a run prompts the SDK session directly, past the
   * wrapper's `send()`; false when Stop or `signal` ended the wait and the run must not start.
   */
  prepareMcpForRun?(signal: AbortSignal): Promise<boolean>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: () => string; chatOnly?: boolean; mcpHost?: McpHost },
  ): HostSession | void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  /** Set once the turn limit ends the run; later steering is refused instead of starting another turn. */
  turnLimitReached?: boolean;
  cancelQueued?: () => boolean;
  /** Ends the wait for the child's MCP servers before its prompt (`prepareChildMcp()`). */
  mcpWait?: AbortController;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
  var __piSubagentPendingReports: Map<string, Map<string, SubagentRunInfo>> | undefined;
  var __piSubagentInFlightReports: Map<string, SubagentRunInfo[]> | undefined;
  var __piSubagentParentWatches: Map<string, { inner: AgentSessionLike; unsubscribe: () => void }> | undefined;
  var __piSubagentFlushingReports: Set<string> | undefined;
  var __piSubagentReportRetries: Map<string, number> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const PARENT_IDLE_RECHECK_MS = 0;
/** One retry after a failed delivery; a session that rejects both attempts waits for the next event. */
const MAX_REPORT_RETRIES = 1;
const SUBAGENT_NOTIFICATION_TYPE = "pi-web:subagent-notification";
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const TURN_LIMIT_INSTRUCTION = "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

/**
 * How the last model request ended when `prompt()` resolved anyway: pi records a provider
 * failure, or a request stopped from the child's own chat, on the assistant message.
 */
function lastAssistantStop(sessionManager: { getEntries?: () => unknown }): { aborted?: true; error?: string } | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason === "aborted") return { aborted: true };
    if (entry.message.stopReason !== "error") return undefined;
    return { error: typeof entry.message.errorMessage === "string" && entry.message.errorMessage ? entry.message.errorMessage : "Provider returned an error" };
  }
  return undefined;
}

function turnLimitError(turnLimit: number, undelivered: readonly string[]): string {
  const error = `Subagent reached its turn limit (${turnLimit}) without completing the task.`;
  if (undelivered.length === 0) return error;
  return `${error} These queued messages were not delivered:\n${undelivered.map((text) => `- ${text}`).join("\n")}`;
}

/**
 * A child with `mcp: on` connects its servers before its prompt, as a prompt sent to the wrapper
 * does. The parent's Stop and `abort()` end the wait through `stored.mcpWait`, the child's own
 * Stop through the wrapper; either way the run is aborted before it starts.
 */
async function prepareChildMcp(session: HostSession | void, stored: StoredSubagentExecution): Promise<void> {
  if (!session?.prepareMcpForRun) return;
  const controller = new AbortController();
  stored.mcpWait = controller;
  try {
    if (stored.abortRequested) controller.abort();
    if (await session.prepareMcpForRun(controller.signal)) return;
  } finally {
    stored.mcpWait = undefined;
  }
  stored.abortRequested = true;
  throw new Error("Stopped while connecting MCP servers");
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

/**
 * Background runs whose terminal result the parent has not collected yet, keyed by parent then
 * subagent session, plus the entries currently being delivered. The run has left the run map,
 * but its report still has to reach the parent at the next safe boundary.
 */
function getPendingReports(): Map<string, Map<string, SubagentRunInfo>> {
  if (!(globalThis.__piSubagentPendingReports instanceof Map)) globalThis.__piSubagentPendingReports = new Map();
  return globalThis.__piSubagentPendingReports;
}

function getInFlightReports(): Map<string, SubagentRunInfo[]> {
  if (!(globalThis.__piSubagentInFlightReports instanceof Map)) globalThis.__piSubagentInFlightReports = new Map();
  return globalThis.__piSubagentInFlightReports;
}

/** One `agent_settled` subscription per live parent session, held only while a report is pending. */
function getParentWatches(): Map<string, { inner: AgentSessionLike; unsubscribe: () => void }> {
  if (!(globalThis.__piSubagentParentWatches instanceof Map)) globalThis.__piSubagentParentWatches = new Map();
  return globalThis.__piSubagentParentWatches;
}

function getFlushingReports(): Set<string> {
  if (!(globalThis.__piSubagentFlushingReports instanceof Set)) globalThis.__piSubagentFlushingReports = new Set();
  return globalThis.__piSubagentFlushingReports;
}

/** Per-parent failed deliveries, so a session that keeps rejecting the message is not retried forever. */
function getReportRetries(): Map<string, number> {
  if (!(globalThis.__piSubagentReportRetries instanceof Map)) globalThis.__piSubagentReportRetries = new Map();
  return globalThis.__piSubagentReportRetries;
}

function pendingReportRuns(): SubagentRunInfo[] {
  return [
    ...[...getPendingReports().values()].flatMap((runs) => [...runs.values()]),
    ...[...getInFlightReports().values()].flat(),
  ];
}

function hasPendingReports(parentSessionId: string): boolean {
  return (getPendingReports().get(parentSessionId)?.size ?? 0) > 0;
}

function addPendingReport(run: SubagentRunInfo): void {
  const pending = getPendingReports();
  const runs = pending.get(run.parentSessionId) ?? new Map<string, SubagentRunInfo>();
  // `resume` reuses the session id: its newer run supersedes the earlier one's pending report,
  // since `get_subagent_result` returns the latest run as well.
  runs.set(run.sessionId, run);
  pending.set(run.parentSessionId, runs);
}

function dropPendingReport(run: Pick<SubagentRunInfo, "sessionId" | "parentSessionId" | "completedAt">): void {
  const pending = getPendingReports();
  const runs = pending.get(run.parentSessionId);
  const entry = runs?.get(run.sessionId);
  if (!runs || !entry || entry.completedAt !== run.completedAt) return;
  runs.delete(run.sessionId);
  if (runs.size === 0) pending.delete(run.parentSessionId);
}

function unwatchParent(parentSessionId: string, inner?: AgentSessionLike): void {
  const watches = getParentWatches();
  const watch = watches.get(parentSessionId);
  if (!watch || (inner && watch.inner !== inner)) return;
  watches.delete(parentSessionId);
  // Called from inside an `agent_settled` emit; pi splices its listener array while it
  // iterates it, so the unsubscribe itself waits for the current stack to finish.
  queueMicrotask(() => watch.unsubscribe());
}

/**
 * Whether a subagent run under this session, at any depth, is still unsettled: its end can
 * start a turn there (a pending status report with `triggerTurn`). A run counts from dispatch
 * until its result is written (the run map), then until its status report is delivered or fails.
 * A hidden page keeps the session's event stream while this holds (#1283).
 */
export function hasUnsettledSubagentRun(sessionId: string): boolean {
  const runs = [...[...getSubagentRuns().values()].map((stored) => stored.run), ...pendingReportRuns()];
  const family = new Set([sessionId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const run of runs) {
      if (!family.has(run.parentSessionId) || family.has(run.sessionId)) continue;
      family.add(run.sessionId);
      grew = true;
    }
  }
  return family.size > 1;
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Background runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. Only background runs are recorded — a
 * foreground run never notifies — and each session holds at most one entry.
 */
function getConsumedSubagentResults(): Map<string, string> {
  // A hot reload can leave the pre-#987 Set on globalThis; replace it rather than call Map methods on it.
  if (!(globalThis.__piSubagentConsumedResults instanceof Map)) globalThis.__piSubagentConsumedResults = new Map();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(run: Pick<SubagentRunInfo, "sessionId" | "parentSessionId" | "completedAt">): void {
  // A terminal run without `completedAt` (interrupted) never notifies, so there is nothing to drop.
  if (!run.completedAt) return;
  getConsumedSubagentResults().set(run.sessionId, run.completedAt);
  // A report already waiting for its parent, or one being delivered right now, is not due:
  // the parent read this very run itself.
  dropPendingReport(run);
  const inFlight = getInFlightReports();
  const claimed = inFlight.get(run.parentSessionId);
  if (claimed) {
    const remaining = claimed.filter((claimedRun) =>
      claimedRun.sessionId !== run.sessionId || claimedRun.completedAt !== run.completedAt);
    if (remaining.length === 0) inFlight.delete(run.parentSessionId);
    else inFlight.set(run.parentSessionId, remaining);
  }
  // Nothing else is waiting for that parent: its settle subscription can go.
  if (!hasPendingReports(run.parentSessionId) && !inFlight.has(run.parentSessionId)) {
    unwatchParent(run.parentSessionId);
  }
}

/** Take the mark only when it names this very run; a mark left by an earlier run is ignored. */
function takeResultConsumed(run: SubagentRunIdentity): boolean {
  const consumed = getConsumedSubagentResults();
  if (!run.completedAt || consumed.get(run.sessionId) !== run.completedAt) return false;
  consumed.delete(run.sessionId);
  return true;
}

/**
 * A run lives in `getSubagentRuns()` from dispatch until its result entry is written, so a
 * persisted `running` / `queued` status reaching `get()` without that entry (and without a running
 * wrapper) was left by a process that stopped mid-run and will never be finished. Report it as
 * `interrupted` so `get_subagent_result({ wait: true })` returns instead of polling forever, and
 * `resume` can pick the session up again.
 */
function settleOrphanedRun(run: SubagentRunInfo): SubagentRunInfo {
  return run.status === "running" || run.status === "queued" ? { ...run, status: "interrupted" } : run;
}

function findSubagentModel(runtime: ModelRuntime, reference: string) {
  const slash = reference.indexOf("/");
  if (slash > 0) return runtime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
  const matches = runtime.getModels().filter((model) => model.id === reference);
  if (matches.length > 1) throw new Error(`Subagent model is ambiguous; use provider/modelId: ${reference}`);
  return matches[0];
}

/**
 * Reads a model reference as pi's `--model` does: `provider/modelId` or a bare id, optionally
 * followed by `:<thinking level>`. The whole reference is tried first, so an id that itself
 * contains a colon (`qwen3:8b`) still matches; a suffix that is no thinking level never matches.
 */
function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const exact = findSubagentModel(runtime, requested);
  if (exact) return { model: exact };
  const colon = requested.lastIndexOf(":");
  const level = requested.slice(colon + 1) as ThinkingLevel;
  if (colon > 0 && THINKING_LEVELS.has(level)) {
    const model = findSubagentModel(runtime, requested.slice(0, colon));
    if (model) return { model, thinkingLevel: level };
  }
  throw new Error(`Subagent model not found: ${requested}`);
}

/**
 * The model the child is expected to run (the call's, else the profile's, else the parent's),
 * looked up early to size `input_files` before a worktree or child session exists (#1199). It
 * never throws: the child's model is resolved for real, and a bad reference refused, only after
 * the child's services have refreshed the shared runtime from models.json and registered its
 * extensions' providers. A reference this lookup misses leaves the files the flat limit.
 */
function expectedSubagentModel(
  runtime: ModelRuntime,
  callModel: string | undefined,
  profileModel: string | undefined,
  parentModel: AgentSessionLike["model"],
) {
  try {
    const reference = callModel?.trim() || profileModel?.trim();
    return reference ? parseSubagentModel(runtime, reference)?.model : parentModel;
  } catch {
    return undefined;
  }
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

/**
 * pi creates a session file only once the session holds a user or assistant message, so a run
 * that ended before its prompt reached the model (stopped while queued or connecting MCP servers,
 * a provider without credentials) kept its metadata and result in memory only. Once the idle
 * child's wrapper was released, `get_subagent_result` and `resume` answered `Subagent not found`
 * for an id the parent had been given, and the session left the sidebar. Write the file when the
 * child is dispatched; `setSessionFile()` reloads it, so pi appends every later entry to it.
 */
function persistChildSession(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header || existsSync(sessionFile)) return;
  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx" });
  sessionManager.setSessionFile(sessionFile);
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Writes a settled run's result entry, which `readSubagentRun()` reads back, and returns the run as
 * recorded. An isolated run's entry keeps whether its worktree path still exists now, which decides
 * what the parent is told about it, live and read back alike (#1202): a checkout removed during
 * the run is gone though git's removal then failed, and a resumed run removes nothing.
 */
function recordResult(sessionManager: SessionManager, run: SubagentRunInfo): SubagentRunInfo {
  const recorded = run.worktreePath ? { ...run, worktreeExists: existsSync(run.worktreePath) } : run;
  const entry: SubagentResultMetadata = {
    version: 1,
    status: recorded.status as SubagentResultMetadata["status"],
    completedAt: recorded.completedAt!,
    ...(recorded.result ? { result: recorded.result } : {}),
    ...(recorded.error ? { error: recorded.error } : {}),
    ...(recorded.worktreeCleanupError ? { worktreeCleanupError: recorded.worktreeCleanupError } : {}),
    ...(recorded.worktreeExists !== undefined ? { worktreeExists: recorded.worktreeExists } : {}),
  };
  sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, entry);
  return recorded;
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    let isolatedWorktree: { path: string; branch: string } | undefined;
    try {
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      // Sized by the window of the model expected to read the copy, and refused before a worktree
      // or child session exists.
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? [], subagentInputLimits(
        expectedSubagentModel(parentModelRuntime, request.model, profile.model, parent.inner.model),
      ));
      if (isolation === "worktree") {
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const inheritContext = profile.inheritContext;
      // `parseProfileFile` already floors a positive profile `max_turns`, so it is an integer or absent.
      const turnLimit = profile.maxTurns;

      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(childCwd, agentDir);
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: profile.tools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const parentCodemodeEnabled = parent.inner.getActiveToolNames().includes("codemode");
      const wantsCodemode = profile.codemode === "on"
        || (profile.codemode === "inherit" && parentCodemodeEnabled);
      if (promptPlan.chatOnly && profile.codemode === "on") {
        throw new Error("Code mode cannot be enabled for a chat-only subagent profile");
      }
      // A chat-only profile remains chat-only when inheritance is selected. An explicit `on`
      // is rejected above so it cannot silently grant a script capability to tools:none.
      const codemodeEnabled = !promptPlan.chatOnly && wantsCodemode;
      if (promptPlan.chatOnly && profile.mcp === "on") {
        throw new Error("MCP cannot be enabled for a chat-only subagent profile");
      }
      const mcpEnabled = profile.mcp === "on";
      const chatOnly = promptPlan.chatOnly;
      const { appendSystemPrompt, delegatedTask } = promptPlan;
      const skillsBinding = createSubagentSkillsBinding({
        loadSkills: profile.loadSkills,
        skills: profile.skills,
        exactSystemPrompt: promptPlan.exactSystemPrompt,
      });
      const codemodeExtension = codemodeEnabled
        ? await createSubagentCodemodeExtension({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
          })
        : undefined;
      // The policy reads the child's tools once they are resolved below.
      const mcpScope: { tools: readonly string[]; allExtensionTools?: boolean } = { tools: [] };
      const mcp = mcpEnabled
        ? await createSubagentMcpExtensions({
            agentDir,
            cwd: childCwd,
            projectTrusted: () => settingsManager.isProjectTrusted(),
            codemode: codemodeEnabled,
          })
        : undefined;
      const extensionFactories = [
        ...(codemodeExtension ? [codemodeExtension] : []),
        ...(mcp ? [...mcp.extensions, createSubagentMcpPolicyExtension(() => mcpScope)] : []),
        ...(skillsBinding.loaderOptions.extensionFactories ?? []),
      ];
      if (!chatOnly) initTheme();
      const services = await createAgentSessionServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          ...subagentExtensionLoaderOptions({ ...profile, mcp: mcpEnabled }),
          ...skillsBinding.loaderOptions,
          ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
        },
        ...((profile.loadExtensions || profile.loadSkills || codemodeEnabled || mcpEnabled)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      });

      if (codemodeEnabled && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
        throw new Error("Code mode is unavailable: builtin:codemode was not registered");
      }

      // `ext:` selectors that `disallowed_tools` cancels out leave an empty list, which admits none.
      const allExtensionTools = profile.loadExtensions && profile.extensionTools === undefined;
      const extensionToolNames = profile.loadExtensions
        ? profile.extensionTools !== undefined
          ? selectSubagentExtensionTools(
            services.resourceLoader.getExtensions().extensions,
            profile.extensionTools,
            profile.disallowedExtensionTools,
          )
          : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(profile.tools, extensionToolNames),
        settingsManager.getDefaultTools(),
      );
      if (codemodeEnabled && !activeTools.includes("codemode")) activeTools.push("codemode");
      mcpScope.tools = activeTools;
      mcpScope.allExtensionTools = allExtensionTools;

      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          ...(codemodeEnabled ? { codemode: true as const } : {}),
          ...(mcpEnabled ? { mcp: true as const } : {}),
          loadSkills: profile.loadSkills,
          ...(profile.skills !== undefined ? { skills: [...profile.skills] } : {}),
          loadExtensions: profile.loadExtensions,
          ...(allExtensionTools ? { allExtensionTools: true } : {}),
          ...(profile.extensions !== undefined ? { extensions: [...profile.extensions] } : {}),
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      // A `:level` suffix travels with its model. As with pi's `--thinking` over `--model x:level`,
      // the profile's own `thinking` beats a suffix on the profile's model, while a call naming
      // a model with a suffix chose both for this run.
      const callModel = parseSubagentModel(parentModelRuntime, request.model);
      const profileModel = callModel ? undefined : parseSubagentModel(parentModelRuntime, profile.model);
      const thinking = callModel?.thinkingLevel
        ?? profile.thinking
        ?? profileModel?.thinkingLevel
        ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }
      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: (callModel ?? profileModel)?.model ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        ...subagentToolOptions({ tools: activeTools, allExtensionTools, mcp: mcpEnabled }),
      });
      persistChildSession(sessionManager);
      skillsBinding.setActiveToolsGetter(() => inner.getActiveToolNames());
      const childSession = dependencies.registerSession(inner, {
        ...(skillsBinding.getExactSystemPrompt !== undefined
          ? { exactSystemPrompt: skillsBinding.getExactSystemPrompt }
          : {}),
        chatOnly,
        ...(mcp?.mcpHost ? { mcpHost: mcp.mcpHost } : {}),
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else if (stored.mcpWait) stored.mcpWait.abort();
        else void inner.abort();
      };
      if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

      const execute = async (): Promise<SubagentRunInfo> => {
        // Reached only when the abort fires while the run is being queued, before `cancelQueued`
        // is set; a run aborted later in the queue ends in `finishQueuedAbort`.
        if (stored.abortRequested) {
          const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
          const result = recordResult(sessionManager, {
            ...initialRun,
            status: "aborted",
            completedAt: new Date().toISOString(),
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          });
          stored.run = result;
          request.onUpdate?.(result);
          getSubagentRuns().delete(initialRun.sessionId);
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
        let turnCount = 0;
        let maxTurnsReached = false;
        let undelivered: string[] = [];
        const previousFinishTurn = inner.agent.finishTurn;
        const previousSteeringMode = inner.agent.steeringMode;
        let unsubscribeTools: (() => void) | undefined;
        if (turnLimit) {
          // Finalized events retain the SDK's terminate hint; tool-result messages do not.
          const terminatingTools = new Set<string>();
          unsubscribeTools = inner.subscribe((event) => {
            if (event.type === "tool_execution_end" && event.result?.terminate === true) {
              terminatingTools.add(event.toolCallId);
            }
          });
          inner.agent.finishTurn = async (turn, signal) => {
            const decision = (await previousFinishTurn?.(turn, signal)) ?? undefined;
            const toolsContinue = turn.toolResults.some((message) => !terminatingTools.has(message.toolCallId));
            terminatingTools.clear();
            turnCount += 1;
            if (signal?.aborted || decision?.action === "end" ||
              turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
            const needsAnotherTurn = toolsContinue || decision?.action === "continue" || inner.agent.hasQueuedMessages();
            if (!needsAnotherTurn || turnCount < turnLimit) return decision;
            if (turnCount >= turnLimit + 1) {
              maxTurnsReached = true;
              stored.turnLimitReached = true;
              // AgentSession starts another run for anything still queued, past an `end`
              // decision, so the limit holds only once the queues are empty.
              const { steering, followUp } = inner.clearQueue();
              undelivered = [...undelivered, ...steering, ...followUp];
              return { action: "end" };
            }
            // The awaited SDK boundary delivers the instruction before the wrap-up request.
            // In one-at-a-time mode a steer queued earlier would take the wrap-up turn and
            // leave the instruction for later, so that turn takes everything queued.
            inner.agent.steeringMode = "all";
            await inner.steer(TURN_LIMIT_INSTRUCTION);
            return decision;
          };
        }
        let result: SubagentRunInfo;
        try {
          await prepareChildMcp(childSession, stored);
          await inner.prompt(delegatedTask, { source: "rpc" });
          const text = inner.getLastAssistantText()?.trim();
          const stop = stored.abortRequested ? undefined : lastAssistantStop(sessionManager);
          const aborted = stored.abortRequested || stop?.aborted === true;
          const errorMessage = aborted ? undefined : stop?.error ??
            (maxTurnsReached && turnLimit ? turnLimitError(turnLimit, undelivered) : undefined);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : errorMessage ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        } catch (error) {
          const text = inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested || request.signal?.aborted;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted
              ? { error: error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          if (turnLimit) {
            inner.agent.finishTurn = previousFinishTurn;
            inner.agent.steeringMode = previousSteeringMode;
          }
          unsubscribeTools?.();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        result = recordResult(sessionManager, result);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        return result;
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        const finalResult = recordResult(sessionManager, cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result);
        stored.run = finalResult;
        request.onUpdate?.(finalResult);
        getSubagentRuns().delete(initialRun.sessionId);
        dependencies.invalidateSessionList();
        resolveCompletion(finalResult);
      };
      const queued = getSubagentQueue().enqueue(
        parentSessionId,
        readSubagentSettings().maxConcurrent,
        execute,
        (state) => {
          if (state === "queued") {
            sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
          }
          request.onUpdate?.({ ...stored.run, status: state });
          stored.run = { ...stored.run, status: state };
          dependencies.invalidateSessionList();
        },
        finishQueuedAbort,
      );
      stored.cancelQueued = queued.cancel;
      void queued.promise.then(resolveCompletion, (error) => {
        resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      });

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const existing = await get(request.sessionId);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");
    // The run prompts the SDK session directly, past the wrapper's `send()`, so refuse here as
    // `send()` does: an isolated child's worktree is removed when its run ends, and a run in the
    // missing folder would only let the model's tools fail (and `write` recreate it outside git).
    // The error reaches the model, so it also says what to do instead.
    if (!existsSync(wrapper.cwd)) throw new Error(`Directory does not exist: ${wrapper.cwd}. Start a new subagent instead.`);

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      // Resume removes no worktree: this run's result says only whether it is still there.
      worktreeCleanupError: undefined,
      worktreeExists: undefined,
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false };
    getSubagentRuns().set(request.sessionId, stored);
    request.onUpdate?.(initialRun);
    dependencies.invalidateSessionList();
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else if (stored.mcpWait) stored.mcpWait.abort();
      else void wrapper!.inner.abort();
    };
    if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

    const execute = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
        stored.run = result;
        getSubagentRuns().delete(request.sessionId);
        resolveCompletion(result);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
      request.onUpdate?.(stored.run);
      let result: SubagentRunInfo;
      try {
        await prepareChildMcp(wrapper, stored);
        await wrapper!.inner.prompt(request.task, { source: "rpc" });
        const text = wrapper!.inner.getLastAssistantText()?.trim();
        const stop = stored.abortRequested ? undefined : lastAssistantStop(manager);
        const aborted = stored.abortRequested || stop?.aborted === true;
        const providerError = aborted ? undefined : stop?.error;
        result = {
          ...initialRun,
          status: aborted ? "aborted" : providerError ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(providerError ? { error: providerError } : {}),
        };
      } catch (error) {
        result = {
          ...initialRun,
          status: stored.abortRequested || request.signal?.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(!stored.abortRequested && !request.signal?.aborted ? { error: error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        request.signal?.removeEventListener("abort", handleParentAbort);
      }
      result = recordResult(manager, result);
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      return result;
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      const result = recordResult(manager, { ...initialRun, status: "aborted", completedAt: new Date().toISOString() });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      dependencies.invalidateSessionList();
      resolveCompletion(result);
    };
    const queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
      if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
      stored.run = { ...stored.run, status: state };
      request.onUpdate?.(stored.run);
      dependencies.invalidateSessionList();
    }, finishQueuedAbort);
    stored.cancelQueued = queued.cancel;
    void queued.promise.then(resolveCompletion, (error) => resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }));
    return { run: stored.run, completion };
  }

  async function get(sessionId: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return settleOrphanedRun(run);
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
    return run && settleOrphanedRun(run);
  }

  async function steer(sessionId: string, message: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (getSubagentRuns().get(sessionId)?.turnLimitReached) throw new Error("Subagent reached its turn limit and is stopping; resume it to continue");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  /**
   * The last assistant message's `stopReason` says whether the parent's latest run was stopped
   * from its own chat: a status after a Stop must not start an unattended run.
   */
  function lastParentRunWasAborted(parent: HostSession): boolean {
    if (!parent.inner.sessionManager) return false;
    return lastAssistantStop(parent.inner.sessionManager)?.aborted === true;
  }

  /**
   * `agent_settled` is the only point where a report may start a turn: the parent's run is over
   * (including every queued follow-up), so the message cannot be injected into work in progress.
   * The subscription lives only while a report is pending for that parent.
   */
  function watchParentSettled(parentSessionId: string, parent: HostSession): void {
    const watches = getParentWatches();
    if (watches.get(parentSessionId)?.inner === parent.inner) return;
    unwatchParent(parentSessionId);
    const inner = parent.inner;
    if (typeof inner.subscribe !== "function") return;
    const unsubscribe = inner.subscribe((event) => {
      if (event.type !== "agent_settled") return;
      const live = dependencies.getSession(parentSessionId);
      if (!live?.isAlive()) return;
      // A replacement session owns its own run: reattach and let that session deliver.
      if (live.inner !== inner) {
        watchParentSettled(parentSessionId, live);
        if (!live.isRunning()) scheduleIdleReport(parentSessionId);
        return;
      }
      if (!hasPendingReports(parentSessionId)) {
        unwatchParent(parentSessionId, inner);
        return;
      }
      // Called synchronously from the settle emit: `sendCustomMessage` sees the SDK's settle
      // flag and defers the message until the settle handlers are done. A run pi recorded as
      // stopped counts as a Stop even if the controller did not request it.
      void deliverPendingReports(parentSessionId, live, {
        aborted: event.aborted === true || lastParentRunWasAborted(live),
        settled: true,
      });
    });
    watches.set(parentSessionId, { inner, unsubscribe });
  }

  /**
   * A run that has just settled may still count as running through its wrapper (the prompt
   * promise resolves a microtask later). One idle check catches that tail; a real run keeps the
   * settle watch instead.
   */
  function scheduleIdleReport(parentSessionId: string): void {
    setTimeout(() => {
      if (!hasPendingReports(parentSessionId)) return;
      const parent = dependencies.getSession(parentSessionId);
      if (!parent?.isAlive() || parent.isRunning()) return;
      void deliverPendingReports(parentSessionId, parent, {
        aborted: lastParentRunWasAborted(parent),
        settled: false,
      });
    }, PARENT_IDLE_RECHECK_MS);
  }

  /**
   * Takes every unconsumed report for one parent. A parent that already collected a run through
   * `get_subagent_result` leaves its mark, checked again here, so no status is sent for it.
   */
  function claimPendingReports(parentSessionId: string): SubagentRunInfo[] {
    const pending = getPendingReports();
    const runs = pending.get(parentSessionId);
    if (!runs) return [];
    const claimed: SubagentRunInfo[] = [];
    for (const [sessionId, run] of runs) {
      runs.delete(sessionId);
      if (takeResultConsumed(run)) continue;
      claimed.push(run);
    }
    if (runs.size === 0) pending.delete(parentSessionId);
    claimed.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
    return claimed;
  }

  function restorePendingReports(parentSessionId: string, runs: readonly SubagentRunInfo[]): void {
    for (const run of runs) {
      // A fetch that landed during the failed delivery still suppresses the report.
      if (run.parentSessionId !== parentSessionId || takeResultConsumed(run)) continue;
      addPendingReport(run);
    }
  }

  async function deliverPendingReports(
    parentSessionId: string,
    parent: HostSession,
    options: { aborted: boolean; settled: boolean },
  ): Promise<void> {
    if (!hasPendingReports(parentSessionId)) {
      if (!getInFlightReports().has(parentSessionId)) unwatchParent(parentSessionId);
      return;
    }
    if (getFlushingReports().has(parentSessionId)) return;
    if (!options.settled) {
      if (parent.isRunning()) {
        watchParentSettled(parentSessionId, parent);
        return;
      }
      await parent.waitUntilReady();
      // A prompt admitted while extensions bound counts as busy even before its run streams.
      if (parent.isRunning()) {
        watchParentSettled(parentSessionId, parent);
        return;
      }
    }

    const flushing = getFlushingReports();
    // A triggered `sendCustomMessage` resolves only when the run it started settles, so this
    // flag holds later reports through that status turn as well: none may interrupt it.
    flushing.add(parentSessionId);
    let claimed: SubagentRunInfo[] = [];
    let retry = false;
    try {
      claimed = claimPendingReports(parentSessionId);
      if (claimed.length === 0) return;
      getInFlightReports().set(parentSessionId, claimed);
      await parent.inner.sendCustomMessage({
        customType: SUBAGENT_NOTIFICATION_TYPE,
        content: subagentStatusNotificationText(claimed),
        display: true,
        details: { kind: "pi-web-subagent-status", runs: claimed.map(subagentToolDetails) },
      }, options.aborted ? undefined : { deliverAs: "followUp", triggerTurn: true });
      getInFlightReports().delete(parentSessionId);
      getReportRetries().delete(parentSessionId);
      claimed = [];
    } catch (error) {
      getInFlightReports().delete(parentSessionId);
      restorePendingReports(parentSessionId, claimed);
      const attempts = (getReportRetries().get(parentSessionId) ?? 0) + 1;
      getReportRetries().set(parentSessionId, attempts);
      retry = attempts <= MAX_REPORT_RETRIES;
      console.error(
        "[pi-web] failed to deliver subagent status:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      flushing.delete(parentSessionId);
      if (!hasPendingReports(parentSessionId)) {
        getReportRetries().delete(parentSessionId);
        unwatchParent(parentSessionId);
        return;
      }
      const live = dependencies.getSession(parentSessionId);
      if (live?.isAlive() && live.isRunning()) watchParentSettled(parentSessionId, live);
      else if (retry) scheduleIdleReport(parentSessionId);
    }
  }

  /**
   * A background run's terminal result is recorded for its parent, never pushed. The parent reads
   * it with `get_subagent_result`; until it does, one aggregated status report is delivered when
   * the parent's turn ends (or at once while the parent is idle), so a finished task cannot be
   * silently lost and a running turn is never redirected by it.
   */
  async function scheduleParentReport(run: SubagentRunInfo): Promise<void> {
    if (!run.runInBackground || !run.completedAt) return;
    if (takeResultConsumed(run)) return;
    addPendingReport(run);
    try {
      let parent = dependencies.getSession(run.parentSessionId);
      if (!parent?.isAlive()) {
        const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
        if (!sessionFile) {
          // The parent session file is gone: nobody can read this report, and keeping it would
          // leave the run family permanently unsettled. The result stays in the child session.
          dropPendingReport(run);
          throw new Error(`Parent session not found: ${run.parentSessionId}`);
        }
        parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
      }
      watchParentSettled(run.parentSessionId, parent);
      if (parent.isRunning()) {
        // The settle watch delivers; the idle recheck covers a run that ended in the same tick.
        scheduleIdleReport(run.parentSessionId);
        return;
      }
      await deliverPendingReports(run.parentSessionId, parent, {
        aborted: lastParentRunWasAborted(parent),
        settled: false,
      });
    } catch (error) {
      console.error(
        "[pi-web] failed to record subagent status:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  async function abort(sessionId: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    // Still connecting its MCP servers: no run to stop yet, so the wait ends instead.
    if (stored?.mcpWait) {
      stored.abortRequested = true;
      stored.mcpWait.abort();
      return;
    }
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    extensionRuntime: { start, resume, get, steer, scheduleParentReport, markResultConsumed },
    get,
    steer,
    abort,
  };
}
