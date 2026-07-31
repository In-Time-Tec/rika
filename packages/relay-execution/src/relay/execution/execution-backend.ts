import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import * as AgentSelection from "@rika/coding-tools/agent-tool-contract"
import * as AgentToolkits from "@rika/coding-tools/agent-tool-contract"
import * as AgentAwait from "@rika/coding-tools/agent-tool-contract"
import * as AgentOutcomes from "@rika/coding-tools/agent-tool-contract"
import * as AgentErrors from "@rika/coding-tools/agent-tool-contract"
import { MediaAnalyzer } from "@rika/coding-tools/media-view-service"
import { type Compaction, ModelRegistry, ModelResilience, type Permissions } from "@batonfx/core"
import { executionEventHistoryFor } from "@rika/configuration/profile-data-paths"
import * as AgentTools from "@rika/coding-tools/agent-tool-contract"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import {

  Client,
  Content,
  ArtifactStore,
  EventHistory,
  type Execution,
  Ids,
  ModelHub,
  PromptAssembler,
  type Resident,
  Runtime,
  ToolRuntime as RelayToolRuntime,
  WorkflowDefinitionHost,
} from "@relayfx/sdk"
import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Encoding,
  Effect,
  Fiber,
  Function,
  Layer,
  LayerMap,
  Option,
  PlatformError,
  Queue,
  Redacted,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { createHash } from "node:crypto"
import { AgentProfile } from "@rika/product/execution-child-run"
import { BackendError } from "@rika/product/execution-service"
import type { Event } from "@rika/product/execution-event"
import type { ExecutionReference } from "@rika/product/execution-identifier"
import type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"
import type { PromptPart } from "@rika/product/execution-request"
import { Status } from "@rika/product/execution-status"
import { toExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import {
  agentKeyForName,
  mainInstructions,
  names as agentProfileNames,
  parentPermissions,
  presets,
  resolve,
  resolveTitle,
  rootPermissions,
} from "../../agent/definition/baton-agent-definition"
import * as ContextTokenizer from "../../context-tokenizer"
import * as MediaAnalyzerRuntime from "../../model/provider/media-analysis-adapter"
import * as SubagentJoin from "./subagent-join"
import * as ThreadHost from "./thread-host"
import { workflowDefinitionName } from "../relay-workflow-compiler"
import {

  childExecutionId as encodeChildExecutionId,
  decodeParentExecutionId,
  delegationAvailableAtDepth,
  toolsAtDepth,
} from "../../agent-depth"
import { ExecutionId } from "@rika/product/execution-identifier"
import * as ExecutionStatus from "@rika/product/execution-status"
import * as DataBlobStore from "../../data-blob-store"

import { ExecutionIdentifiers } from "./execution-identifiers"
import * as RuntimeLayer from "./runtime-layer"
import * as ClientLayer from "./client-layer"
import * as FollowRuntime from "./follow-runtime"

const {
  attachedWorkflow,
  awaitExecutionAvailable,
  awaitExecutionRunning,
  checkpointForExecution,
  childIdFromExecutionId,
  childSessionId,
  cursorOf,
  decodeExecutionRouteMetadata,
  executionId,
  makeChildExecutionId,
  sessionId,
  startSessionId,
  standaloneWorkflow,
  threadIdFromMetadata,
  workflowExecutionId,
} = ExecutionIdentifiers
const agentId = Ids.AgentId.make("agent:rika")
const addressId = Ids.AddressId.make("address:rika")
const rootAgentName = "rika"
const executionRouteFromMetadata = decodeExecutionRouteMetadata
const fanOutAgentId = (fanOutId: unknown, childExecutionId: unknown) =>
  Ids.AgentId.make(`agent:rika:fan-out:${String(fanOutId)}:${String(childExecutionId)}`)
export const turnIdFromExecutionId = ExecutionIdentifiers.turnIdFromExecutionId
export const workspaceFromExecutionId = ExecutionIdentifiers.workspaceFromExecutionId

export { streamingOnlyLanguageModel, withStreamingOnlyModel } from "../../streaming-only-model"

export type ModelVariantPolicy = "registration-key" | "fixed-selection"

export type ToolRuntimeRequirements =
  ReturnType<typeof RikaToolRuntime.layer> extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
type SuppliedToolRuntimeRequirements =
  | MediaAnalyzer
  | ModelRegistry.ModelRegistry
  | ProcessRegistry.Service
  | ReadWebPage.Service
  | WebSearch.Service
export type ExternalToolRuntimeRequirements<R> = Exclude<ToolRuntimeRequirements | R, SuppliedToolRuntimeRequirements>

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}

const toolFailureAnnotations = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  return Schema.is(RikaToolRuntime.ToolError)(failure)
    ? {
        "rika.failure.category": failure.category,
        "rika.failure.outcome": failure.outcome,
        "rika.failure.interrupted": false,
      }
    : { "rika.failure.interrupted": Cause.hasInterrupts(cause) }
}

const isExecutionNotFound = (failure: unknown) =>
  failure !== null && typeof failure === "object" && "_tag" in failure && failure._tag === "ExecutionNotFound"

const observableEventTypes = new Set([
  "execution.accepted",
  "execution.started",
  "model.input.prepared",
  "model.output.completed",
  "model.usage.reported",
  "model.attempt.completed",
  "model.attempt.failed",
  "tool.call.requested",
  "tool.result.received",
  "steering.delivered",
  "wait.created",
  "wait.woken",
  "wait.timed_out",
  "wait.cancelled",
  "child_run.spawned",
  "child_fan_out.created",
  "child_fan_out.member.terminal",
  "child_fan_out.terminal",
  "budget.exceeded",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])
const toolExecutionPolicy = { concurrency: "unbounded" as const }
const allowAllPermissionRules = { rules: [], fallback: "allow" } satisfies Permissions.Ruleset
const memoryDatabaseFilename = ":memory:"
const unsafeRecoveryFailure = "Parent execution stopped before its first durable chat checkpoint"
const outlivedParentReason = "Parent execution ended before this subagent's report was collected"
const defaultRecoveryChildSettlementGrace = Duration.seconds(30)
const recoveryRetrySchedule = Schedule.exponential("100 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(5)))),
)

export interface CompactionPolicy {
  readonly context_window: number
  readonly reserve_tokens: number
  readonly keep_recent_tokens: number
  readonly summary_model?: {
    readonly provider: string
    readonly model: string
    readonly registration_key?: string
  }
}

export interface LayerOptions<AdditionalTools extends Record<string, Tool.Any> = {}, RuntimeRequirements = never> {
  readonly filename: string
  readonly workspace: string
  readonly webSearchCredentials?: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly registration: ModelRegistry.Registration
  readonly additionalRegistrations?: ReadonlyArray<ModelRegistry.Registration>
  readonly selection: ModelRegistry.ModelSelection
  readonly oracleSelection?: ModelRegistry.ModelSelection
  readonly compactionSummarySelection?: ModelRegistry.ModelSelection
  readonly defaultReasoningEffort?: string
  readonly modelVariantPolicy?: ModelVariantPolicy
  readonly modelResilience?: ModelResilience.Interface
  readonly compaction?: Compaction.DefaultOptions
  readonly oracleCompaction?: Compaction.DefaultOptions
  readonly additionalToolkit?: Toolkit.Toolkit<AdditionalTools>
  readonly additionalHandlerLayer?: Layer.Layer<
    Tool.HandlersFor<AdditionalTools>,
    BackendError,
    Tool.HandlerServices<AdditionalTools[keyof AdditionalTools]>
  >
  readonly toolRuntimeLayer?: Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements>
  readonly toolRuntimeLayerForWorkspace?: (
    workspace: string,
  ) => Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements | ProcessRegistry.Service>
  readonly resolveWorkspace?: (executionId: string) => Effect.Effect<string, BackendError>
  readonly recoveryChildSettlementGrace?: Duration.Input
}

const routedToolRuntimeLayer: {
  <E, R>(
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ): (
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
  ) => Layer.Layer<
    RikaToolRuntime.Service,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Exclude<R, ProcessRegistry.Service>
  >
  <E, R>(
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ): Layer.Layer<
    RikaToolRuntime.Service,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Exclude<R, ProcessRegistry.Service>
  >
} = Function.dual(
  2,
  <E, R>(
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const dependencies = yield* Effect.context<
          ChildProcessSpawner.ChildProcessSpawner | Exclude<R, ProcessRegistry.Service>
        >()
        const processes = yield* LayerMap.make(() => ProcessRegistry.layer, { idleTimeToLive: "15 minutes" })
        const run = ((request: Schema.Schema.Type<typeof RikaToolRuntime.Request>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const call = yield* RelayToolRuntime.ToolCallInfo
              const workspace = yield* resolveWorkspace(String(call.executionId))
              const processContext = yield* processes.contextEffect(workspace)
              const workspaceLayer = layerForWorkspace(workspace).pipe(
                Layer.provide(Layer.succeedContext(Context.merge(dependencies, processContext))),
              )
              const runtimeContext = yield* Layer.build(workspaceLayer)
              const runtime = Context.get(runtimeContext, RikaToolRuntime.Service)
              const startedAt = yield* Clock.currentTimeMillis
              const deadline = ToolCatalog.get(String(call.call.name))?.timeoutMillis
              yield* Effect.logInfo("tool.started").pipe(
                Effect.annotateLogs({
                  "rika.execution.id": String(call.executionId),
                  "rika.tool.call.id": String(call.call.id),
                  ...(deadline === undefined ? {} : { "rika.tool.deadline.ms": deadline }),
                  "rika.tool.name": String(call.call.name),
                }),
              )
              return yield* runtime.run(request).pipe(
                Effect.tap(() =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((completedAt) =>
                      Effect.logInfo("tool.completed").pipe(
                        Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                      ),
                    ),
                  ),
                ),
                Effect.tapCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Clock.currentTimeMillis.pipe(
                        Effect.flatMap((failedAt) =>
                          Effect.logError("tool.failed").pipe(
                            Effect.annotateLogs({
                              "rika.duration.ms": failedAt - startedAt,
                              ...toolFailureAnnotations(cause),
                              "rika.failure.kind": failureKind(cause),
                            }),
                          ),
                        ),
                      ),
                ),
                Effect.annotateLogs({
                  "rika.execution.id": String(call.executionId),
                  "rika.tool.call.id": String(call.call.id),
                  ...(deadline === undefined ? {} : { "rika.tool.deadline.ms": deadline }),
                  "rika.tool.name": String(call.call.name),
                }),
              )
            }),
          ).pipe(
            Effect.mapError((cause) =>
              Schema.is(RikaToolRuntime.ToolError)(cause)
                ? cause
                : RikaToolRuntime.ToolError.make({
                    tool: request._tag,
                    message:
                      "The tool failed before Rika could classify it. The call may have changed state. Next action: inspect current state before deciding whether another call is safe.",
                    kind: "operation",
                    category: "operation",
                    outcome: "unknown",
                    recovery: "never",
                    nextAction: "Inspect current state before deciding whether another call is safe",
                  }),
            ),
          )) as RikaToolRuntime.Interface["run"]
        return Layer.succeed(RikaToolRuntime.Service, RikaToolRuntime.Service.of({ run }))
      }),
    ),
)

const modelSelectionKey = (selection: ModelRegistry.ModelSelection) =>
  JSON.stringify([selection.provider, selection.model, selection.registrationKey ?? null])

export const lazyModelRegistryLayer = (
  registrations: ReadonlyArray<ModelRegistry.Registration>,
): Layer.Layer<ModelRegistry.ModelRegistry> =>
  Layer.effect(
    ModelRegistry.ModelRegistry,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const memoMap = yield* Layer.makeMemoMap
      const admission = yield* Semaphore.make(1)
      type Entry = {
        readonly registration: ModelRegistry.Registration
        readonly context: Effect.Effect<Context.Context<ModelRegistry.ModelEnvironment>>
      }
      const makeEntry = (registration: ModelRegistry.Registration) =>
        Effect.cached(
          Layer.buildWithMemoMap(registration.layer, memoMap, scope).pipe(
            Effect.map((context) => context as Context.Context<ModelRegistry.ModelEnvironment>),
          ),
        ).pipe(Effect.map((context) => ({ registration, context }) satisfies Entry))
      const initialEntries = yield* Effect.forEach(registrations, makeEntry)
      const entries = yield* Ref.make(
        new Map(initialEntries.map((entry) => [modelSelectionKey(entry.registration), entry] as const)),
      )
      const find = (selection: ModelRegistry.ModelSelection) =>
        Ref.get(entries).pipe(
          Effect.map((current) => current.get(modelSelectionKey(selection))),
          Effect.flatMap((entry) =>
            entry === undefined
              ? Effect.fail(
                  ModelRegistry.LanguageModelNotRegistered.make({
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
                  }),
                )
              : Effect.succeed(entry),
          ),
        )
      const operate: ModelRegistry.Interface["operate"] = (selection, operation) =>
        find(selection).pipe(
          Effect.flatMap((entry) => entry.context),
          Effect.flatMap((context) => operation.pipe(Effect.provide(context))),
        )
      const stream = ((selection: ModelRegistry.ModelSelection, operation: Stream.Stream<unknown, unknown, unknown>) =>
        Stream.unwrap(
          find(selection).pipe(
            Effect.flatMap((entry) => entry.context),
            Effect.map((context) => operation.pipe(Stream.provideContext(context))),
          ),
        )) as ModelRegistry.Interface["stream"]
      return ModelRegistry.ModelRegistry.of({
        register: ({ registration }) =>
          admission.withPermits(1)(
            makeEntry(registration).pipe(
              Effect.flatMap((entry) =>
                Ref.update(entries, (current) => {
                  const updated = new Map(current)
                  updated.set(modelSelectionKey(registration), entry)
                  return updated
                }),
              ),
            ),
          ),
        registrations: Ref.get(entries).pipe(
          Effect.map((current) => Array.from(current.values(), (entry) => entry.registration)),
        ),
        operate,
        stream,
      })
    }),
  )

export const defaultModelResilience: ModelResilience.Interface = ModelResilience.make({
  retrySchedule: Schedule.exponential("500 millis", 2).pipe(Schedule.jittered, Schedule.upTo({ times: 3 })),
})

const withResilience = (
  registration: ModelRegistry.Registration,
  resilience: ModelResilience.Interface | undefined,
): ModelRegistry.Registration => {
  if (resilience === undefined) return registration
  const modelLayer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.pipe(Effect.map((model) => ModelResilience.apply(model, resilience))),
  ).pipe(Layer.provideMerge(registration.layer))
  return { ...registration, layer: modelLayer }
}

export const eventHistoryOption = (filename: string): { readonly eventHistory?: EventHistory.FileSystemConfig } =>
  filename === memoryDatabaseFilename
    ? {}
    : { eventHistory: EventHistory.fileSystem({ directory: executionEventHistoryFor(filename) }) }

const childExecutionIdFromEvent = (item: Execution.ExecutionEvent) => {
  const value = item.child_execution_id ?? item.data?.child_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const registrationFor = <AdditionalTools extends Record<string, Tool.Any>, R>(
  options: LayerOptions<AdditionalTools, R>,
): ModelRegistry.Registration => withResilience(options.registration, options.modelResilience)

const registrationsFor = <AdditionalTools extends Record<string, Tool.Any>, R>(
  options: LayerOptions<AdditionalTools, R>,
): Array<ModelRegistry.Registration> => [
  registrationFor(options),
  ...(options.additionalRegistrations ?? []).map((registration) =>
    withResilience(registration, options.modelResilience),
  ),
]

const relayModelSelection = (selection: ModelRegistry.ModelSelection) => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
})

type ChildRunInputBase = Pick<Execution.SpawnChildRunInput, "child_execution_id" | "address_id" | "input">

type ChildRunOverride = Pick<
  Execution.SpawnChildRunInput,
  | "instructions"
  | "model"
  | "compaction_policy"
  | "tool_names"
  | "permissions"
  | "workspace_policy"
  | "output_schema_ref"
  | "metadata"
>

type ChildRunDefinition =
  | { readonly _tag: "preset"; readonly presetName: AgentProfile }
  | { readonly _tag: "override"; readonly definition: ChildRunOverride }

const buildChildRunInputImpl = (base: ChildRunInputBase, definition: ChildRunDefinition) =>
  definition._tag === "preset" ? { ...base, preset_name: definition.presetName } : { ...base, ...definition.definition }

type ChildRunInput = ReturnType<typeof buildChildRunInputImpl>

export const buildChildRunInput: {
  (definition: ChildRunDefinition): (base: ChildRunInputBase) => ChildRunInput
  (base: ChildRunInputBase, definition: ChildRunDefinition): ChildRunInput
} = Function.dual(2, buildChildRunInputImpl)

const compactionPolicy = (
  compaction: Compaction.DefaultOptions | undefined,
  summaryModel?: ModelRegistry.ModelSelection,
): CompactionPolicy | undefined =>
  compaction === undefined ||
  compaction.contextWindow === undefined ||
  compaction.reserveTokens === undefined ||
  compaction.keepRecentTokens === undefined
    ? undefined
    : {
        context_window: compaction.contextWindow,
        reserve_tokens: compaction.reserveTokens,
        keep_recent_tokens: compaction.keepRecentTokens,
        ...(summaryModel === undefined ? {} : { summary_model: relayModelSelection(summaryModel) }),
      }

const pinnedCompactionPolicy = (
  route: ExecutionRoutePin["main"],
  summaryModel?: ExecutionRoutePin["compactionSummary"],
): CompactionPolicy => ({
  context_window: route.compaction.contextWindow,
  reserve_tokens: route.compaction.reserveTokens,
  keep_recent_tokens: route.compaction.keepRecentTokens,
  ...(summaryModel === undefined ? {} : { summary_model: relayModelSelection(pinnedSelection(summaryModel)) }),
})

const pinnedSelection = (route: ExecutionRoutePin["main"]): ModelRegistry.ModelSelection => ({
  provider: route.providerConnection.provider,
  model: route.model,
  registrationKey: route.registrationIdentity,
})

export const toolkitFor = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit">,
) =>
  Toolkit.make(
    ...Object.values(RikaToolRuntime.toolkit.tools),
    ...Object.values(AgentToolkits.AgentContract.modelToolkit.tools),
    ...Object.values(AgentToolkits.AgentContract.joinToolkit.tools),
    ...Object.values(options.additionalToolkit?.tools ?? {}),
  )

const availableTools = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit">,
  names: ReadonlyArray<string>,
) => {
  const available = toolkitFor(options).tools
  return names.filter((name) => name in available)
}

export const webSearchFactories = (
  credentials: Readonly<Record<string, Redacted.Redacted<string>>>,
): ReturnType<typeof WebSearchProvider.configuredProviderFactories> =>
  WebSearchProvider.configuredProviderFactories(credentials)

export const modelVariantKey: {
  (fast: boolean): (effort: string) => string
  (effort: string, fast: boolean): string
} = Function.dual(2, (effort: string, fast: boolean) => `effort:${effort}${fast ? ":fast" : ""}`)

const variantSelection = (
  selection: ModelRegistry.ModelSelection,
  effort: string | undefined,
  fast: boolean,
  policy: ModelVariantPolicy,
): ModelRegistry.ModelSelection =>
  policy === "fixed-selection" || (effort === undefined && !fast)
    ? selection
    : { ...selection, registrationKey: modelVariantKey(effort ?? "medium", fast) }

const pinnedRouteForExecution = (client: Client.Interface, execution: Execution.Execution) =>
  Effect.gen(function* () {
    let current: Execution.Execution | undefined = execution
    for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
      const route = executionRouteFromMetadata(current.metadata)
      if (route !== undefined) return route
      const parentId: unknown = current.metadata?.parent_execution_id
      current = typeof parentId === "string" ? yield* client.executions.get(Ids.ExecutionId.make(parentId)) : undefined
    }
    return undefined
  })

const terminalExecutionStatus = ExecutionStatus.isTerminalStatus

const childJoinWaitMode = "child"

export interface SubagentWorkInspection {
  readonly child_runs: ReadonlyArray<{ readonly status: ExecutionStatus.Status }>
  readonly waiting_on: ReadonlyArray<{ readonly mode: string }>
}

export const hasLiveSubagentWork = (inspection: SubagentWorkInspection) =>
  inspection.child_runs.some((child) => !terminalExecutionStatus(child.status)) ||
  inspection.waiting_on.some((wait) => wait.mode === childJoinWaitMode)

const retryRecoveryPersistence = <A, E, R>(effect: Effect.Effect<A, E, R>, execution: string) =>
  effect.pipe(
    Effect.tapError(() =>
      Effect.logWarning("execution.recovery.retrying").pipe(Effect.annotateLogs({ "rika.execution.id": execution })),
    ),
  )

const reconcileUnsafeRecovery = (
  client: Client.Interface,
  execution: string,
  childSettlementGrace: Duration.Duration,
) =>
  Effect.gen(function* () {
    const id = Ids.ExecutionId.make(execution)
    const inspect = retryRecoveryPersistence(client.executions.inspect(id), execution).pipe(
      Effect.retry({ schedule: recoveryRetrySchedule }),
    )
    const settled = yield* inspect.pipe(
      Effect.repeat({
        while: (inspection) => inspection.child_runs.some((child) => !terminalExecutionStatus(child.status)),
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeoutOption(childSettlementGrace),
    )
    const reconciledAt = yield* Clock.currentTimeMillis
    yield* retryRecoveryPersistence(
      client.executions.cancel({
        execution_id: id,
        cancelled_at: reconciledAt,
        reason: unsafeRecoveryFailure,
      }),
      execution,
    ).pipe(Effect.retry({ schedule: recoveryRetrySchedule }))
    const inspection = yield* inspect
    yield* Effect.logWarning("execution.recovery.failed_safe").pipe(
      Effect.annotateLogs({
        "rika.execution.id": execution,
        "rika.recovery.child.count": inspection.child_runs.length,
        "rika.recovery.children.settled": Option.isSome(settled),
        "rika.recovery.pending_tool.count": inspection.pending_tool_calls.length,
      }),
    )
  })
const routeForProfile = (pin: ExecutionRoutePin, profile: AgentProfile) => {
  const key = agentKeyForName(profile)
  const configured = key === undefined ? undefined : pin.agents?.[key]
  return configured ?? (usesMainRoute(profile) ? pin.main : pin.oracle)
}

const usesMainRoute = (profile: AgentProfile) => profile === "Task" || profile === "Surgeon"

const InvocationProfile = Schema.Literals(["Root", "Title", ...AgentProfile.literals])

const agentSelections = (pin: ExecutionRoutePin) =>
  pin.agents === undefined
    ? undefined
    : (Object.fromEntries(
        agentProfileNames.map((name) => [name, pinnedSelection(routeForProfile(pin, name))]),
      ) as Partial<Readonly<Record<AgentProfile, ModelRegistry.ModelSelection>>>)
const scrubbedEventMessage = (data: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const message = data?.message
  return typeof message === "string" && message.length > 0 && message !== "[object Object]" ? message : undefined
}

const overflowDetail = (data: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const details =
    typeof data?.details === "object" && data.details !== null
      ? (data.details as Readonly<Record<string, unknown>>)
      : undefined
  return details?.failure_classification === "context-overflow"
    ? "Automatic compaction could not reduce the thread enough for this model."
    : undefined
}

const childFailureText = (terminal: Execution.ExecutionEvent | undefined) => {
  if (terminal?.type !== "execution.failed" && terminal?.type !== "execution.cancelled") return undefined
  const message =
    scrubbedEventMessage(terminal.data) ??
    (terminal.type === "execution.failed" ? overflowDetail(terminal.data) : undefined)
  const outcome =
    terminal.type === "execution.cancelled" ? "Subagent execution was cancelled" : "Subagent execution failed"
  return message !== undefined ? `${outcome}: ${message}` : outcome
}

const silentChildReason = "The subagent finished its run without writing a final report."
const unreconciledReason = (status: string) =>
  `The subagent's execution finished as ${status}, but its final event never reached Rika, so no report was recovered.`

const terminalStatuses: Readonly<Record<string, "completed" | "failed" | "cancelled">> = {
  "execution.completed": "completed",
  "execution.failed": "failed",
  "execution.cancelled": "cancelled",
}

const durableOutput = (event: Execution.ExecutionEvent | undefined): ReadonlyArray<unknown> | undefined => {
  if (event === undefined) return undefined
  if (event.content?.some((part) => part.type === "text" && part.text.trim().length > 0) === true) return event.content
  const text = event.data?.text
  return typeof text === "string" && text.trim().length > 0 ? [{ type: "text", text }] : undefined
}

export interface ChildResultInput {
  readonly childExecutionId: string
  readonly events: ReadonlyArray<Execution.ExecutionEvent>
  readonly reconciled?: "completed" | "failed" | "cancelled"
}

export const resolveChildResult = ({ childExecutionId, events, reconciled }: ChildResultInput): AgentAwait.Result => {
  const terminal = events.findLast((executionEvent) => terminalStatuses[executionEvent.type] !== undefined)
  const resumed =
    events.findLast(
      (executionEvent) => executionEvent.type === "model.call.started" || executionEvent.type === "tool.call.requested",
    )?.sequence ?? -1
  const report = durableOutput(
    events.findLast(
      (executionEvent) =>
        (executionEvent.type === "model.output.completed" || executionEvent.type === "model.cycle.completed") &&
        executionEvent.sequence > resumed &&
        durableOutput(executionEvent) !== undefined,
    ),
  )
  const output = report ?? durableOutput(terminal)
  const failure = childFailureText(terminal)
  const status = (terminal === undefined ? undefined : terminalStatuses[terminal.type]) ?? reconciled ?? "failed"
  if (status === "cancelled")
    return AgentOutcomes.AgentContract.cancelled({
      childExecutionId,
      reason: failure ?? unreconciledReason(status),
      output: output ?? [],
    })
  if (output === undefined || !Arr.isReadonlyArrayNonEmpty(output)) {
    if (status === "completed")
      return AgentOutcomes.AgentContract.noReport({ childExecutionId, reason: silentChildReason, status })
    return AgentOutcomes.AgentContract.noReport({ childExecutionId, reason: failure ?? unreconciledReason(status) })
  }
  if (status === "completed") return AgentOutcomes.AgentContract.report({ childExecutionId, output })
  return AgentOutcomes.AgentContract.failed({ childExecutionId, reason: failure ?? unreconciledReason(status), output })
}
const terminalChildStatuses = new Set(["completed", "failed", "cancelled"])

const awaitChildResult = (client: Client.Interface, childId: string) => {
  const childExecutionId = Ids.ExecutionId.make(childId)
  return awaitExecutionAvailable(client, childExecutionId).pipe(
    Effect.flatMap(() =>
      Effect.gen(function* () {
        const inspection = yield* client.executions.inspect(childExecutionId)
        if (terminalChildStatuses.has(inspection.status)) {
          const page = yield* client.executions.pageEvents({
            execution_id: childExecutionId,
            direction: "backward",
            limit: 256,
          })
          return resolveChildResult({
            childExecutionId: childId,
            events: page.events,
            reconciled: inspection.status as "completed" | "failed" | "cancelled",
          })
        }
        const items = yield* Stream.runCollect(
          client.executions.follow({
            execution_id: childExecutionId,
            ...(inspection.last_event_cursor === undefined ? {} : { after_cursor: inspection.last_event_cursor }),
          }),
        )
        const collected = [...items]
        const stopped = collected.find(
          (item): item is Extract<typeof item, { _tag: "stopped" }> => item._tag === "stopped",
        )
        const reconciled = stopped?.reason._tag === "terminal" ? stopped.reason.status : undefined
        return resolveChildResult({
          childExecutionId: childId,
          events: collected.flatMap((item) => (item._tag === "event" ? [item.event] : [])),
          ...(reconciled === "completed" || reconciled === "failed" || reconciled === "cancelled"
            ? { reconciled }
            : {}),
        })
      }),
    ),
  )
}
const isBackendError = Schema.is(BackendError)
const error = (cause: unknown): BackendError =>
  isBackendError(cause) ? cause : BackendError.make({ message: String(cause) })
const executionInput = (input: { readonly prompt: string; readonly promptParts?: ReadonlyArray<PromptPart> }) => {
  if (input.promptParts === undefined) return [Content.text(input.prompt)]
  const parts: Array<ReturnType<typeof Content.text> | ReturnType<typeof DataBlobStore.reference>> = []
  let pendingText: string | undefined
  const flushText = () => {
    if (pendingText === undefined) return
    parts.push(Content.text(pendingText))
    pendingText = undefined
  }
  for (const part of input.promptParts) {
    if (part.type === "text") {
      pendingText = (pendingText ?? "") + part.text
      continue
    }
    flushText()
    parts.push(DataBlobStore.reference(part.mediaType, part.data, part.filename))
  }
  flushText()
  return parts
}

const mapFanOut = (value: any) => {
  const parentTurnId = ExecutionId.executionKey(String(value.parent_execution_id))
  return {
    fanOutId: String(value.fan_out_id),
    parentTurnId,
    state: value.state,
    maxConcurrency: value.max_concurrency,
    join: value.join._tag,
    members: value.members.map((member: any) => ({
      childId: childIdFromExecutionId(parentTurnId, member.child_execution_id),
      ordinal: member.ordinal,
      state: member.state,
      ...(member.output === undefined
        ? {}
        : {
            output: Array.isArray(member.output)
              ? member.output.map((part: any) => (part.type === "text" ? part.text : JSON.stringify(part))).join("")
              : member.output,
          }),
      ...(member.error === undefined ? {} : { error: member.error }),
    })),
  }
}

const workflow = (value: any) => {
  const execution = String(value.execution_id)
  const attached = attachedWorkflow(execution)
  const standalone = standaloneWorkflow(execution)
  return {
    runId: attached?.runId ?? standalone?.runId ?? execution.replace(/^workflow:/, ""),
    ...(attached === undefined ? {} : { ownerTurnId: attached.ownerTurnId }),
    workflow: workflowDefinitionName(String(value.pin.workflow_definition_id)),
    revision: value.pin.workflow_definition_revision,
    digest: value.pin.workflow_definition_digest,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

const failureMessage = (data: Readonly<Record<string, unknown>> | undefined): string | undefined => {
  const scrubbed = scrubbedEventMessage(data)
  if (scrubbed !== undefined) return scrubbed
  const overflow = overflowDetail(data)
  if (overflow !== undefined) return overflow
  return data?.message === "[object Object]" ? "The execution failed unexpectedly." : undefined
}

const event = (value: {
  readonly execution_id: string
  readonly child_execution_id?: string | undefined
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly created_at: number
  readonly timestamp_source?: string | undefined
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string | undefined }> | undefined
  readonly data?: Readonly<Record<string, unknown>> | undefined
}): Event => {
  const contentText = value.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
  const failureText = value.type === "execution.failed" ? failureMessage(value.data) : undefined
  const text = contentText !== undefined && contentText.length > 0 ? contentText : failureText
  return {
    executionId: value.execution_id,
    ...(value.child_execution_id === undefined ? {} : { childExecutionId: value.child_execution_id }),
    cursor: value.cursor,
    sequence: value.sequence,
    type: value.type,
    createdAt: value.created_at,
    ...(value.timestamp_source === undefined ? {} : { timestampSource: value.timestamp_source }),
    ...(text === undefined ? {} : { text }),
    ...(value.content === undefined ? {} : { content: [...value.content] }),
    ...(value.data === undefined ? {} : { data: value.data }),
  }
}

const statusFromEvents = (events: ReadonlyArray<Event>): Status => {
  const type = events.findLast(
    (item) =>
      item.type === "execution.completed" || item.type === "execution.failed" || item.type === "execution.cancelled",
  )?.type
  if (type === "execution.completed") return "completed"
  if (type === "execution.failed") return "failed"
  if (type === "execution.cancelled") return "cancelled"
  if (events.findLast((item) => item.type === "wait.created") !== undefined) return "waiting"
  return "running"
}

const isActionableWait = (item: Event) =>
  item.type === "permission.ask.requested" || item.type === "tool.approval.requested"

const executionTreeIds = (client: Client.Interface, root: Ids.ExecutionId) =>
  Effect.gen(function* () {
    const pending = [root]
    const seen = new Set<string>()
    const ids: Array<Ids.ExecutionId> = []
    while (pending.length > 0) {
      const current = pending.shift()!
      if (seen.has(String(current))) continue
      seen.add(String(current))
      ids.push(current)
      const inspection = yield* client.executions.inspect(current)
      for (const child of inspection.child_runs) {
        pending.push(Ids.ExecutionId.make(String(child.child_execution_id)))
      }
    }
    return ids
  })

const cancelOutlivingChildren = (
  client: Client.Interface,
  root: Ids.ExecutionId,
  cancelledAt?: number,
  knownTree?: ReadonlyArray<Ids.ExecutionId>,
) =>
  Effect.gen(function* () {
    const ids = (knownTree ?? (yield* executionTreeIds(client, root))).slice(1)
    const live: Array<Ids.ExecutionId> = []
    for (const id of ids) {
      const inspection = yield* client.executions.inspect(id)
      if (!terminalExecutionStatus(inspection.status)) live.push(id)
    }
    if (live.length === 0) return
    const cancellationTime = cancelledAt ?? (yield* Clock.currentTimeMillis)
    yield* Effect.logWarning("execution.subagents.outlived_parent").pipe(
      Effect.annotateLogs({
        "rika.execution.id": String(root),
        "rika.subagent.count": live.length,
      }),
    )
    yield* Effect.forEach(
      live.toReversed(),
      (id) =>
        client.executions.cancel({ execution_id: id, cancelled_at: cancellationTime, reason: outlivedParentReason }),
      { concurrency: 1, discard: true },
    )
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("execution.subagents.cancel_failed").pipe(
        Effect.annotateLogs({ "rika.execution.id": String(root), "rika.failure.kind": failureKind(cause) }),
      ),
    ),
  )

const traceWithoutResult = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let result!: A
    return effect.pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          result = value
        }),
      ),
      Effect.asVoid,
      Effect.withSpan(name),
      Effect.andThen(Effect.sync(() => result)),
    )
  })

const zeroPriceFromMetadata = (metadata: ModelRegistry.Metadata | undefined) => {
  const pricing = metadata?.pricing
  if (
    pricing !== null &&
    typeof pricing === "object" &&
    pricing !== undefined &&
    (pricing as { inputPerMTok?: unknown }).inputPerMTok === 0 &&
    (pricing as { outputPerMTok?: unknown }).outputPerMTok === 0
  )
    return { amount: 0, currency: "USD" }
  return undefined
}


const followExecution = FollowRuntime.followExecution

export const layerFromClient = ClientLayer.layerFromClient

export const RelayInternals: {
  readonly addressId: typeof addressId
  readonly agentId: typeof agentId
  readonly agentSelections: typeof agentSelections
  readonly allowAllPermissionRules: typeof allowAllPermissionRules
  readonly awaitChildResult: typeof awaitChildResult
  readonly awaitExecutionAvailable: typeof awaitExecutionAvailable
  readonly awaitExecutionRunning: typeof awaitExecutionRunning
  readonly cancelOutlivingChildren: typeof cancelOutlivingChildren
  readonly checkpointForExecution: typeof checkpointForExecution
  readonly childExecutionIdFromEvent: typeof childExecutionIdFromEvent
  readonly childJoinWaitMode: typeof childJoinWaitMode
  readonly childSessionId: typeof childSessionId
  readonly compactionPolicy: typeof compactionPolicy
  readonly cursorOf: typeof cursorOf
  readonly defaultRecoveryChildSettlementGrace: typeof defaultRecoveryChildSettlementGrace
  readonly error: typeof error
  readonly event: typeof event
  readonly eventHistoryOption: typeof eventHistoryOption
  readonly executionId: typeof executionId
  readonly executionInput: typeof executionInput
  readonly executionRouteFromMetadata: typeof executionRouteFromMetadata
  readonly executionTreeIds: typeof executionTreeIds
  readonly fanOutAgentId: typeof fanOutAgentId
  readonly failureKind: typeof failureKind
  readonly followExecution: typeof followExecution
  readonly hasLiveSubagentWork: typeof hasLiveSubagentWork
  readonly InvocationProfile: typeof InvocationProfile
  readonly isActionableWait: typeof isActionableWait
  readonly isExecutionNotFound: typeof isExecutionNotFound
  readonly layerFromClient: typeof layerFromClient
  readonly lazyModelRegistryLayer: typeof lazyModelRegistryLayer
  readonly makeChildExecutionId: typeof makeChildExecutionId
  readonly mapFanOut: typeof mapFanOut
  readonly observableEventTypes: typeof observableEventTypes
  readonly parentPermissions: typeof parentPermissions
  readonly pinnedCompactionPolicy: typeof pinnedCompactionPolicy
  readonly pinnedRouteForExecution: typeof pinnedRouteForExecution
  readonly pinnedSelection: typeof pinnedSelection
  readonly presets: typeof presets
  readonly reconcileUnsafeRecovery: typeof reconcileUnsafeRecovery
  readonly recoveryRetrySchedule: typeof recoveryRetrySchedule
  readonly relayModelSelection: typeof relayModelSelection
  readonly registrationsFor: typeof registrationsFor
  readonly resolve: typeof resolve
  readonly resolveTitle: typeof resolveTitle
  readonly routeForProfile: typeof routeForProfile
  readonly rootAgentName: typeof rootAgentName
  readonly routedToolRuntimeLayer: typeof routedToolRuntimeLayer
  readonly startSessionId: typeof startSessionId
  readonly statusFromEvents: typeof statusFromEvents
  readonly terminalExecutionStatus: typeof terminalExecutionStatus
  readonly threadIdFromMetadata: typeof threadIdFromMetadata
  readonly toolExecutionPolicy: typeof toolExecutionPolicy
  readonly toolkitFor: typeof toolkitFor
  readonly availableTools: typeof availableTools
  readonly traceWithoutResult: typeof traceWithoutResult
  readonly usesMainRoute: typeof usesMainRoute
  readonly variantSelection: typeof variantSelection
  readonly webSearchFactories: typeof webSearchFactories
  readonly workflow: typeof workflow
  readonly workflowExecutionId: typeof workflowExecutionId
  readonly withResilience: typeof withResilience
  readonly zeroPriceFromMetadata: typeof zeroPriceFromMetadata
} = {
  addressId, agentId, agentSelections, allowAllPermissionRules, awaitChildResult, awaitExecutionAvailable, awaitExecutionRunning, cancelOutlivingChildren, checkpointForExecution, childExecutionIdFromEvent, childJoinWaitMode, childSessionId, compactionPolicy, cursorOf, defaultRecoveryChildSettlementGrace, error, event, eventHistoryOption, executionId, executionInput, executionRouteFromMetadata, executionTreeIds, fanOutAgentId, failureKind, followExecution, hasLiveSubagentWork, InvocationProfile, isActionableWait, isExecutionNotFound, layerFromClient, lazyModelRegistryLayer, makeChildExecutionId, mapFanOut, observableEventTypes, parentPermissions, pinnedCompactionPolicy, pinnedRouteForExecution, pinnedSelection, presets, reconcileUnsafeRecovery, recoveryRetrySchedule, relayModelSelection, registrationsFor, resolve, resolveTitle, routeForProfile, rootAgentName, routedToolRuntimeLayer, startSessionId, statusFromEvents, terminalExecutionStatus, threadIdFromMetadata, toolExecutionPolicy, toolkitFor, availableTools, traceWithoutResult, usesMainRoute, variantSelection, webSearchFactories, workflow, workflowExecutionId, withResilience, zeroPriceFromMetadata,
}

export const layer = RuntimeLayer.layer
