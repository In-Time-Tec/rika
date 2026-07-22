import { type Compaction, ModelRegistry, ModelResilience, type Permissions } from "@batonfx/core"
import {
  AgentTools,
  Catalog as ToolCatalog,
  MediaView,
  ProcessRegistry,
  ReadWebPage,
  Runtime as RikaToolRuntime,
  WebSearch,
} from "@rika/tools"
import {
  ChildFanOutHost,
  Client,
  Content,
  type Execution,
  Ids,
  ModelHub,
  type Resident,
  Runtime,
  ToolRuntime as RelayToolRuntime,
  WorkflowDefinitionHost,
} from "@relayfx/sdk"
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Function,
  Layer,
  LayerMap,
  Option,
  PlatformError,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  type AgentProfile,
  BackendError,
  Event,
  type ExecutionReference,
  type ExecutionRoutePin,
  type EventScope,
  type PromptPart,
  Service,
  type StartInput,
  Status,
} from "./execution-contract"
import { mainInstructions, parentPermissions, presets, resolve } from "./agent-profiles"
import * as MediaAnalyzer from "./media-analyzer"
import * as ThreadHost from "./thread-host"
import { definitions, idFor } from "./workflow-definitions"
import {
  childExecutionDepth,
  childExecutionId as encodeChildExecutionId,
  delegationAvailableAtDepth,
  toolsAtDepth,
} from "./agent-depth"
import { resolveSpawnModel } from "./agent-model"
import * as DataBlobStore from "./data-blob-store"
import * as ImageInputModel from "./image-input-model"

export { streamingOnlyLanguageModel, withStreamingOnlyModel } from "./streaming-only-model"

export type ModelVariantPolicy = "registration-key" | "fixed-selection"

type ToolRuntimeRequirements =
  ReturnType<typeof RikaToolRuntime.layer> extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
type SuppliedToolRuntimeRequirements =
  | MediaView.MediaAnalyzer
  | ModelRegistry.ModelRegistry
  | ProcessRegistry.Service
  | ReadWebPage.Service
  | WebSearch.Service
type ExternalToolRuntimeRequirements<R> = Exclude<ToolRuntimeRequirements | R, SuppliedToolRuntimeRequirements>

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
  "tool.call.requested",
  "tool.result.received",
  "steering.delivered",
  "tool.approval.requested",
  "tool.approval.resolved",
  "permission.ask.requested",
  "permission.ask.resolved",
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
  readonly webSearchCredentialsForWorkspace?: (
    workspace: string,
  ) => Effect.Effect<Readonly<Record<string, Redacted.Redacted<string>>>, BackendError>
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
  readonly permissionPolicy?: Permissions.Ruleset
  readonly permissionPolicyForExecution?: (executionId: string) => Effect.Effect<Permissions.Ruleset, BackendError>
  readonly additionalToolkit?: Toolkit.Toolkit<AdditionalTools>
  readonly additionalHandlerLayer?: Layer.Layer<Tool.HandlersFor<AdditionalTools>, BackendError, never>
  readonly toolRuntimeLayer?: Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements>
  readonly toolRuntimeLayerForWorkspace?: (
    workspace: string,
  ) => Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements | ProcessRegistry.Service>
  readonly resolveWorkspace?: (executionId: string) => Effect.Effect<string, BackendError>
  readonly toolNeedsApproval?: (name: string) => boolean
}

export const routedToolRuntimeLayer: {
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
        const processes = yield* LayerMap.make(() => ProcessRegistry.layer, { idleTimeToLive: Duration.infinity })
        const run = ((request: RikaToolRuntime.Request) =>
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
                  Clock.currentTimeMillis.pipe(
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

export const defaultModelResilience: ModelResilience.Interface = ModelResilience.make({
  retrySchedule: Schedule.exponential("500 millis", 2).pipe(Schedule.jittered, Schedule.upTo({ times: 3 })),
})

const withResilience = (
  registration: ModelRegistry.Registration,
  resilience: ModelResilience.Interface | undefined,
): ModelRegistry.Registration => {
  const imageInputLayer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.pipe(Effect.map(ImageInputModel.make)),
  ).pipe(Layer.provideMerge(registration.layer))
  if (resilience === undefined) return { ...registration, layer: imageInputLayer }
  const modelLayer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.LanguageModel.pipe(Effect.map((model) => ModelResilience.apply(model, resilience))),
  ).pipe(Layer.provideMerge(imageInputLayer))
  return { ...registration, layer: modelLayer }
}

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
  provider: route.provider,
  model: route.model,
  registrationKey: route.registrationKey,
})

export const toolkitFor = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit" | "webSearchCredentials">,
) =>
  Toolkit.make(
    ...Object.values(RikaToolRuntime.toolkit.tools).filter(
      (tool) =>
        (tool.name !== "web_search" || WebSearch.providerAvailability(options.webSearchCredentials ?? {}).search) &&
        (tool.name !== "read_web_page" || WebSearch.providerAvailability(options.webSearchCredentials ?? {}).readPage),
    ),
    ...Object.values(AgentTools.modelToolkit.tools),
    ...Object.values(options.additionalToolkit?.tools ?? {}),
  )

const availableTools = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit" | "webSearchCredentials">,
  names: ReadonlyArray<string>,
) => {
  const available = toolkitFor(options).tools
  return names.filter((name) => name in available)
}

export const webSearchFactories = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) =>
  WebSearch.configuredProviderFactories(credentials)

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

const agentId = Ids.AgentId.make("agent:rika")
const addressId = Ids.AddressId.make("address:rika")
const fanOutAgentId = (fanOutId: unknown, childExecutionId: unknown) =>
  Ids.AgentId.make(`agent:rika:fan-out:${String(fanOutId)}:${String(childExecutionId)}`)
const executionId = (turnId: string, reference?: ExecutionReference) =>
  Ids.ExecutionId.make(reference === undefined ? `execution:${turnId}` : turnId)
const awaitExecutionAvailable = (
  client: Client.Interface,
  id: Ids.ExecutionId,
  timeoutMessage: string,
): Effect.Effect<void, Client.ClientError> => {
  const poll: Effect.Effect<void, Client.ClientError> = Effect.suspend(() =>
    client.executions
      .get(id)
      .pipe(
        Effect.flatMap((existing) =>
          existing === undefined ? Effect.sleep("25 millis").pipe(Effect.andThen(poll)) : Effect.void,
        ),
      ),
  )
  return poll.pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(Client.ClientError.make({ message: timeoutMessage })),
    }),
  )
}
const makeChildExecutionId = (parentTurnId: string, childId: string) =>
  Ids.ChildExecutionId.make(encodeChildExecutionId(parentTurnId, childId))
const modelSelection = (model: {
  readonly provider: string
  readonly model: string
  readonly registration_key?: string
}): ModelRegistry.ModelSelection => ({
  provider: model.provider,
  model: model.model,
  ...(model.registration_key === undefined ? {} : { registrationKey: model.registration_key }),
})
const executionRouteFromMetadata = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const route = metadata?.rika_execution_route
  if (route === null || typeof route !== "object" || !("main" in route) || !("oracle" in route)) return undefined
  return route as unknown as ExecutionRoutePin
}
const pinnedRouteForExecution = (client: Client.Interface, execution: Execution.Execution) =>
  Effect.gen(function* () {
    let current: Execution.Execution | undefined = execution
    for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
      const route =
        executionRouteFromMetadata(current.metadata) ??
        executionRouteFromMetadata(current.agent_snapshot?.metadata) ??
        executionRouteFromMetadata(current.agent_snapshot?.model.metadata)
      if (route !== undefined) return route
      const parentId: unknown = current.metadata?.parent_execution_id
      current = typeof parentId === "string" ? yield* client.executions.get(Ids.ExecutionId.make(parentId)) : undefined
    }
    return undefined
  })
const routeForProfile = (pin: ExecutionRoutePin, profile: AgentProfile) => {
  if (profile === "Oracle") return pin.oracle
  if (pin.agents === undefined) return pin.main
  if (profile === "Librarian") return pin.agents.librarian
  if (profile === "Painter") return pin.agents.painter
  if (profile === "Review") return pin.agents.review
  if (profile === "ReadThread") return pin.agents.readThread
  return pin.agents.task
}
const executionRoutes = (pin: ExecutionRoutePin) => [
  pin.main,
  pin.oracle,
  ...(pin.title === undefined ? [] : [pin.title]),
  ...(pin.compactionSummary === undefined ? [] : [pin.compactionSummary]),
  ...(pin.agents === undefined
    ? []
    : [pin.agents.librarian, pin.agents.painter, pin.agents.review, pin.agents.readThread, pin.agents.task]),
]
const routeForSelection = (pin: ExecutionRoutePin, selection: ModelRegistry.ModelSelection) =>
  executionRoutes(pin).find(
    (route) =>
      route.provider === selection.provider &&
      route.model === selection.model &&
      route.registrationKey === selection.registrationKey,
  )
const recoveredDeltaOutput = (events: ReadonlyArray<Execution.ExecutionEvent>) => {
  const groups = new Map<string, { order: number; deltas: Array<{ index: number; delta: string }> }>()
  for (const event of events) {
    if (event.type !== "model.output.delta") continue
    const delta = event.data?.delta
    if (typeof delta !== "string" || delta.length === 0) continue
    const partId = typeof event.data?.part_id === "string" ? event.data.part_id : ""
    const group = groups.get(partId) ?? { order: groups.size, deltas: [] }
    const index = typeof event.data?.delta_index === "number" ? event.data.delta_index : group.deltas.length
    group.deltas.push({ index, delta })
    groups.set(partId, group)
  }
  const text = [...groups.values()]
    .toSorted((left, right) => left.order - right.order)
    .map((group) =>
      group.deltas
        .toSorted((left, right) => left.index - right.index)
        .map((entry) => entry.delta)
        .join(""),
    )
    .join("\n\n")
  return text.length === 0 ? [] : [{ type: "text", text }]
}

const childFailureText = (terminal: Execution.ExecutionEvent | undefined) => {
  if (terminal?.type !== "execution.failed" && terminal?.type !== "execution.cancelled") return undefined
  const message = terminal.data?.message
  const outcome =
    terminal.type === "execution.cancelled" ? "Subagent execution was cancelled" : "Subagent execution failed"
  return typeof message === "string" && message.length > 0 ? `${outcome}: ${message}` : outcome
}

export const resolveChildResult = (events: ReadonlyArray<Execution.ExecutionEvent>) => {
  const terminal = events.findLast(
    (executionEvent) =>
      executionEvent.type === "execution.completed" ||
      executionEvent.type === "execution.failed" ||
      executionEvent.type === "execution.cancelled",
  )
  const lastToolSequence =
    events.findLast(
      (executionEvent) =>
        executionEvent.type === "tool.call.requested" || executionEvent.type === "tool.result.received",
    )?.sequence ?? -1
  const finalResponse = events.findLast(
    (executionEvent) =>
      executionEvent.type === "model.output.completed" &&
      executionEvent.sequence > lastToolSequence &&
      executionEvent.content?.some((part) => part.type === "text" && part.text.trim().length > 0) === true,
  )
  const recovered = terminal?.type === "execution.failed" && finalResponse !== undefined
  const terminalContent =
    terminal?.content === undefined || terminal.content.length === 0 ? undefined : terminal.content
  const primary =
    recovered || terminalContent === undefined
      ? (finalResponse?.content ?? recoveredDeltaOutput(events))
      : terminalContent
  const failure =
    recovered || terminalContent !== undefined || finalResponse !== undefined ? undefined : childFailureText(terminal)
  let status: "completed" | "cancelled" | "failed" = "failed"
  if (terminal?.type === "execution.completed" || recovered) status = "completed"
  else if (terminal?.type === "execution.cancelled") status = "cancelled"
  return {
    status,
    output: failure === undefined ? primary : [...primary, { type: "text", text: failure }],
  }
}
const awaitChildResult = (client: Client.Interface, childId: string) => {
  const childExecutionId = Ids.ExecutionId.make(childId)
  return client.executions.stream({ execution_id: childExecutionId }).pipe(
    Stream.takeUntil(
      (item) =>
        item.type === "execution.completed" || item.type === "execution.failed" || item.type === "execution.cancelled",
    ),
    Stream.runCollect,
    Effect.map((events) => resolveChildResult([...events])),
  )
}
const workflowExecutionId = (runId: string, ownerTurnId?: string, workspace?: string) => {
  if (ownerTurnId !== undefined)
    return Ids.ExecutionId.make(`workflow:turn:${encodeURIComponent(ownerTurnId)}:run:${encodeURIComponent(runId)}`)
  if (workspace !== undefined)
    return Ids.ExecutionId.make(`workflow:workspace:${encodeURIComponent(workspace)}:run:${encodeURIComponent(runId)}`)
  return Ids.ExecutionId.make(`workflow:${runId}`)
}
const attachedWorkflow = (value: string) => {
  const match = /^workflow:turn:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { ownerTurnId: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}
const childParentExecutionId = (value: string) => {
  if (!value.startsWith("child:")) return undefined
  const separator = value.indexOf(":", "child:".length)
  if (separator < 0) return undefined
  try {
    return decodeURIComponent(value.slice("child:".length, separator))
  } catch {
    return undefined
  }
}
const standaloneWorkflow = (value: string) => {
  const match = /^workflow:workspace:([^:]+):run:(.+)$/.exec(value)
  if (match === null) return undefined
  try {
    return { workspace: decodeURIComponent(match[1]!), runId: decodeURIComponent(match[2]!) }
  } catch {
    return undefined
  }
}
const childIdFromExecutionId = (parentTurnId: string, value: unknown) => {
  const id = String(value)
  const prefix = `child:${encodeURIComponent(parentTurnId)}:`
  return id.startsWith(prefix) ? id.slice(prefix.length) : id.replace(/^child:/, "")
}
export const turnIdFromExecutionId = (value: string): string | undefined => {
  if (value.startsWith("execution:")) {
    const id = value.slice("execution:".length)
    const separator = id.indexOf(":child:")
    return separator < 0 ? id : id.slice(0, separator)
  }
  const workflowOwner = attachedWorkflow(value)?.ownerTurnId
  if (workflowOwner !== undefined) return workflowOwner
  const parent = childParentExecutionId(value)
  if (parent === undefined) return undefined
  if (parent.startsWith("workflow:") || parent.startsWith("execution:") || parent.startsWith("child:"))
    return turnIdFromExecutionId(parent)
  return parent
}
export const workspaceFromExecutionId = (value: string): string | undefined => {
  const workflow = standaloneWorkflow(value)
  if (workflow !== undefined) return workflow.workspace
  const parent = childParentExecutionId(value)
  return parent === undefined ? undefined : workspaceFromExecutionId(parent)
}
const sessionId = (threadId: string) => Ids.SessionId.make(`session:${threadId}`)
const startSessionId = (input: Pick<StartInput, "threadId" | "sessionPurpose">) =>
  input.sessionPurpose?._tag === "ThreadTitle"
    ? Ids.SessionId.make(`session:aux:title:${input.sessionPurpose.owningTurnId}`)
    : sessionId(input.threadId)
const childSessionId = (childExecutionId: Ids.ChildExecutionId) =>
  Ids.SessionId.make(`session:child:${String(childExecutionId)}`)
const isBackendError = Schema.is(BackendError)
const error = (cause: unknown): BackendError =>
  isBackendError(cause) ? cause : BackendError.make({ message: String(cause) })
const executionInput = (input: { readonly prompt: string; readonly promptParts?: ReadonlyArray<PromptPart> }) =>
  input.promptParts?.map((part) =>
    part.type === "text" ? Content.text(part.text) : DataBlobStore.reference(part.mediaType, part.data, part.filename),
  ) ?? [Content.text(input.prompt)]

const mapFanOut = (value: any) => {
  const parentTurnId = String(value.parent_execution_id).replace(/^execution:/, "")
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
    workflow: String(value.pin.workflow_definition_id)
      .replace(/^rika:/, "")
      .replace(/:v1$/, ""),
    revision: value.pin.workflow_definition_revision,
    digest: value.pin.workflow_definition_digest,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

const event = (value: {
  readonly cursor: string
  readonly sequence: number
  readonly type: string
  readonly created_at: number
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly data?: Readonly<Record<string, unknown>>
}): Event => {
  const contentText = value.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
  const failureText =
    value.type === "execution.failed" && typeof value.data?.message === "string" && value.data.message.length > 0
      ? value.data.message
      : undefined
  const text = contentText !== undefined && contentText.length > 0 ? contentText : failureText
  return {
    cursor: value.cursor,
    sequence: value.sequence,
    type: value.type,
    createdAt: value.created_at,
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

const followExecution = (
  client: Client.Interface,
  turnId: string,
  afterCursor: string | undefined,
  onEvent: ((item: Event) => void) | undefined,
  stopAtActionableWait = true,
  reference?: ExecutionReference,
  eventScope: EventScope = "tree",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("execution.follow.started")
      const rootExecutionId = executionId(turnId, reference)
      const events: Array<Event> = []
      const followed = new Set<string>()
      const tracedDeltas = new Set<string>()
      const updates = yield* Queue.unbounded<
        | {
            readonly _tag: "event"
            readonly event: Event
            readonly actionable: boolean
            readonly terminal?: Status
          }
        | { readonly _tag: "stopped"; readonly status: Status; readonly actionable: boolean }
        | { readonly _tag: "failed"; readonly error: BackendError }
      >()
      const attributedEvent = (item: Execution.ExecutionEvent, childExecutionId: string | undefined) =>
        event(
          childExecutionId === undefined
            ? item
            : {
                ...item,
                data: { ...item.data, execution_id: childExecutionId },
              },
        )
      let launch!: (
        execution: Ids.ExecutionId,
        root: boolean,
        cursor?: string,
      ) => Effect.Effect<void, never, Scope.Scope>
      const followOne = (execution: Ids.ExecutionId, root: boolean, cursor: string | undefined) => {
        const consume = (nextCursor: string | undefined) =>
          Stream.runForEachWhile(
            client.executions.follow({
              execution_id: execution,
              ...(nextCursor === undefined ? {} : { after_cursor: nextCursor }),
            }),
            (item) => {
              if (item._tag === "reconnecting")
                return root
                  ? Effect.logWarning("execution.follow.reconnecting").pipe(
                      Effect.annotateLogs({
                        "rika.reconnect.attempt": item.attempt,
                        "rika.reconnect.message": item.message,
                      }),
                      Effect.as(true),
                    )
                  : Effect.succeed(true)
              if (item._tag === "stopped") {
                if (!root || item.reason._tag === "actionable_wait") {
                  if (item.reason._tag !== "actionable_wait") return Effect.succeed(false)
                  return Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true }).pipe(
                    Effect.as(false),
                  )
                }
                return Queue.offer(updates, {
                  _tag: "stopped",
                  status: Status.make(item.reason.status),
                  actionable: false,
                }).pipe(Effect.as(false))
              }
              const spawnedChild = childExecutionIdFromEvent(item.event)
              const mapped = attributedEvent(item.event, root ? undefined : String(execution))
              let terminal: Status | undefined
              if (mapped.type === "execution.completed") terminal = Status.make("completed")
              else if (mapped.type === "execution.failed") terminal = Status.make("failed")
              else if (mapped.type === "execution.cancelled") terminal = Status.make("cancelled")
              const inspectActionable =
                stopAtActionableWait && isActionableWait(mapped) && typeof mapped.data?.wait_id === "string"
                  ? client.executions
                      .inspect(execution)
                      .pipe(
                        Effect.map((inspection) =>
                          inspection.waiting_on.some((wait) => wait.wait_id === mapped.data?.wait_id),
                        ),
                      )
                  : Effect.succeed(false)
              return Effect.gen(function* () {
                const actionable = yield* inspectActionable
                yield* Queue.offer(updates, {
                  _tag: "event",
                  event: mapped,
                  actionable: actionable && !root,
                  ...(root && terminal !== undefined ? { terminal } : {}),
                })
                if (eventScope === "tree" && spawnedChild !== undefined)
                  yield* launch(Ids.ExecutionId.make(spawnedChild), false)
                if (actionable && root)
                  yield* Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true })
                return terminal === undefined && !actionable
              })
            },
          )
        return Effect.gen(function* () {
          const inspection = yield* client.executions.inspect(execution).pipe(
            Effect.retry({
              while: isExecutionNotFound,
              schedule: Schedule.spaced("10 millis"),
              times: 100,
            }),
          )
          if (eventScope === "tree")
            yield* Effect.forEach(
              inspection.child_runs,
              (child) => launch(Ids.ExecutionId.make(String(child.child_execution_id)), false),
              { discard: true },
            )
          yield* consume(cursor).pipe(Effect.catchTag("EventLogCursorNotFound", () => consume(undefined)))
        }).pipe(
          Effect.catchCause((cause) =>
            root
              ? Queue.offer(updates, {
                  _tag: "failed",
                  error: BackendError.make({
                    message: isExecutionNotFound(Cause.squash(cause)) ? "ExecutionNotFound" : Cause.pretty(cause),
                  }),
                }).pipe(Effect.asVoid)
              : Effect.logWarning("execution.child.follow.failed").pipe(
                  Effect.annotateLogs({
                    "rika.execution.id": String(execution),
                    "rika.failure.kind": failureKind(cause),
                  }),
                ),
          ),
        )
      }
      launch = (execution, root, cursor) =>
        Effect.suspend(() => {
          const key = String(execution)
          if (followed.has(key)) return Effect.void
          followed.add(key)
          return followOne(execution, root, cursor).pipe(Effect.forkScoped, Effect.asVoid)
        })
      yield* launch(rootExecutionId, true, afterCursor)
      let stoppedAtActionableWait = false
      let stoppedStatus: Status | undefined
      while (stoppedStatus === undefined) {
        const update = yield* Queue.take(updates)
        if (update._tag === "failed") return yield* update.error
        if (update._tag === "stopped") {
          stoppedAtActionableWait = update.actionable
          stoppedStatus = update.status
          continue
        }
        events.push(update.event)
        onEvent?.(update.event)
        const traceDelta =
          update.event.type === "model.reasoning.delta" ||
          update.event.type === "model.output.delta" ||
          update.event.type === "model.toolcall.delta"
        if (!traceDelta || !tracedDeltas.has(update.event.type)) {
          if (traceDelta) tracedDeltas.add(update.event.type)
          if (traceDelta || observableEventTypes.has(update.event.type))
            yield* Effect.logInfo("execution.event.received").pipe(
              Effect.annotateLogs({
                "rika.event.cursor": update.event.cursor,
                "rika.event.sequence": update.event.sequence,
                "rika.event.type": update.event.type,
              }),
            )
        }
        if (update.actionable) {
          stoppedAtActionableWait = true
          stoppedStatus = "waiting"
        } else if (update.terminal !== undefined) stoppedStatus = update.terminal
      }
      const status = stoppedStatus ?? statusFromEvents(events)
      const completedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("execution.follow.completed").pipe(
        Effect.annotateLogs({
          "rika.duration.ms": completedAt - startedAt,
          "rika.event.count": events.length,
          "rika.execution.status": status,
        }),
      )
      let finalStatus = status
      if (stoppedAtActionableWait && (status === "running" || status === "queued")) {
        finalStatus = Status.make("waiting")
      }
      return {
        turnId,
        status: finalStatus,
        events,
      }
    }),
  ).pipe(
    Effect.tapCause((cause) =>
      reference !== undefined && String(Cause.squash(cause)).includes("ExecutionNotFound")
        ? Effect.logInfo("execution.follow.missing")
        : Effect.logError("execution.follow.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
    ),
    Effect.annotateLogs({
      "rika.execution.id": String(executionId(turnId, reference)),
      "rika.turn.id": turnId,
    }),
  )

export const layerFromClient = <AdditionalTools extends Record<string, Tool.Any> = {}>(
  options: Pick<
    LayerOptions<AdditionalTools>,
    | "selection"
    | "oracleSelection"
    | "compactionSummarySelection"
    | "additionalToolkit"
    | "compaction"
    | "oracleCompaction"
    | "permissionPolicy"
    | "permissionPolicyForExecution"
    | "defaultReasoningEffort"
    | "modelVariantPolicy"
  > & {
    readonly workspace?: string
    readonly resolveWorkspace?: LayerOptions["resolveWorkspace"]
    readonly webSearchCredentials?: LayerOptions["webSearchCredentials"]
    readonly webSearchCredentialsForWorkspace?: LayerOptions["webSearchCredentialsForWorkspace"]
    readonly registerModels?: (registrations: ReadonlyArray<ModelRegistry.Registration>) => Effect.Effect<void>
    readonly onClientReady?: (client: Client.Interface) => Effect.Effect<void>
  },
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* Client.Service
      if (options.onClientReady !== undefined) yield* options.onClientReady(client)
      const permissionPolicyFor = (execution: string) =>
        options.permissionPolicyForExecution === undefined
          ? Effect.succeed(options.permissionPolicy)
          : options
              .permissionPolicyForExecution(execution)
              .pipe(Effect.map((policy) => policy as Permissions.Ruleset | undefined))
      const toolOptionsForExecution = (execution: string) =>
        Effect.gen(function* () {
          const workspace =
            options.resolveWorkspace === undefined
              ? (options.workspace ?? "")
              : yield* options.resolveWorkspace(execution)
          const credentials =
            options.webSearchCredentialsForWorkspace === undefined
              ? options.webSearchCredentials
              : yield* options.webSearchCredentialsForWorkspace(workspace)
          return { ...options, webSearchCredentials: credentials ?? {} }
        })
      const registry =
        Option.getOrUndefined(yield* Effect.serviceOption(ThreadHost.Registry)) ?? (yield* ThreadHost.makeRegistry)
      const hostInstances = new Map<string, Resident.Instance>()
      const hostReady = yield* Effect.cached(
        Effect.gen(function* () {
          yield* client.agents.register({
            id: ThreadHost.hostAgentId,
            name: "rika-thread-host",
            instructions: "Promote pending Rika turns delivered to this thread host.",
            model: ThreadHost.hostSelection,
            tools: Object.values(ThreadHost.toolkit.tools).map((tool) => ({ name: tool.name })),
            permissions: [
              { name: "relay.inbox.wait", value: true },
              { name: "relay.inbox.send", value: true },
            ],
            max_wait_turns: ThreadHost.hostMaxWaitTurns,
            metadata: { steering_enabled: false, inbox_enabled: true },
          })
          yield* client.residents.registerKind({
            kind: ThreadHost.entityKind,
            agent_id: ThreadHost.hostAgentId,
            inbox: { drain: "all" },
            state_enabled: false,
            continue_as_new_after_turns: ThreadHost.continueAsNewAfterTurns,
            metadata: { product: "rika" },
          })
        }),
      )
      const hostGate = yield* Semaphore.make(1)
      const entityFor = Effect.fn("ExecutionBackend.entityFor")(function* (threadId: string, now: number) {
        let recovering = false
        const existing = yield* client.residents.get({
          kind: ThreadHost.entityKind,
          key: Ids.ResidentKey.make(threadId),
        })
        if (existing?.status === "active") {
          const inspection = yield* client.executions.inspect(existing.execution_id)
          if (
            inspection.status === "completed" ||
            inspection.status === "failed" ||
            inspection.status === "cancelled"
          ) {
            recovering = true
            yield* Effect.logWarning("thread_host.recovery.started").pipe(
              Effect.annotateLogs({
                "rika.thread.id": threadId,
                "rika.execution.id": existing.execution_id,
                "rika.execution.status": inspection.status,
                "rika.thread_host.generation": existing.generation,
              }),
            )
            yield* client.residents.destroy({
              kind: ThreadHost.entityKind,
              key: Ids.ResidentKey.make(threadId),
              reason: "thread host execution ended; recreating a fresh generation",
              destroyed_at: now,
            })
            hostInstances.delete(threadId)
          }
        }
        const instance = yield* client.residents.spawn({
          kind: ThreadHost.entityKind,
          key: Ids.ResidentKey.make(threadId),
          metadata: { rika_thread_id: threadId },
          created_at: now,
        })
        if (recovering)
          yield* Effect.logInfo("thread_host.recovery.completed").pipe(
            Effect.annotateLogs({
              "rika.thread.id": threadId,
              "rika.execution.id": instance.execution_id,
              "rika.thread_host.generation": instance.generation,
            }),
          )
        return instance
      })
      const hostInstance = Effect.fn("ExecutionBackend.hostInstance")(function* (threadId: string, now: number) {
        yield* hostReady
        const cached = hostInstances.get(threadId)
        if (cached !== undefined && cached.status === "active") return cached
        const instance = yield* entityFor(threadId, now)
        hostInstances.set(threadId, instance)
        return instance
      })
      const awaitParkedHost = Effect.fn("ExecutionBackend.awaitParkedHost")(function* (
        threadId: string,
        instance: Resident.Instance,
        now: number,
      ) {
        const outcome = yield* Effect.gen(function* () {
          const inspection = yield* client.executions.inspect(instance.execution_id)
          if (
            inspection.status === "completed" ||
            inspection.status === "failed" ||
            inspection.status === "cancelled"
          ) {
            return "terminal" as const
          }
          if (inspection.waiting_on.length === 0) {
            return yield* Client.ClientError.make({ message: `Thread host for ${threadId} is not parked yet` })
          }
          return "parked" as const
        }).pipe(
          Effect.retry({ schedule: Schedule.spaced(Duration.millis(50)), times: 100 }),
          Effect.orElseSucceed(() => "unknown" as const),
        )
        if (outcome !== "terminal") return instance
        yield* client.residents.destroy({
          kind: ThreadHost.entityKind,
          key: Ids.ResidentKey.make(threadId),
          reason: "thread host execution ended; recreating a fresh generation",
          destroyed_at: now,
        })
        hostInstances.delete(threadId)
        const recreated = yield* entityFor(threadId, now)
        hostInstances.set(threadId, recreated)
        return recreated
      })
      return Service.of({
        ...(options.registerModels === undefined ? {} : { registerModels: options.registerModels }),
        wakeThreadHost: Effect.fn("ExecutionBackend.wakeThreadHost")(function* (wake) {
          yield* hostGate
            .withPermits(1)(
              Effect.gen(function* () {
                const created = yield* hostInstance(wake.threadId, wake.now)
                const instance = yield* awaitParkedHost(wake.threadId, created, wake.now)
                const notification = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
                  kind: "queue-ready",
                  thread_id: wake.threadId,
                  wake_generation: wake.generation,
                  queue_revision: wake.queueRevision,
                })
                yield* client.envelopes.send({
                  from: addressId,
                  to: instance.address_id,
                  content: [Content.text(notification)],
                  idempotency_key: `rika:queue-wake:${wake.threadId}:${wake.generation}`,
                })
              }),
            )
            .pipe(
              Effect.tapCause((cause) =>
                Effect.logError("thread_host.notification.failed").pipe(
                  Effect.annotateLogs({
                    "rika.thread.id": wake.threadId,
                    "rika.queue.wake_generation": wake.generation,
                    "rika.queue.revision": wake.queueRevision,
                    "rika.failure.kind": failureKind(cause),
                  }),
                ),
              ),
              Effect.mapError(error),
            )
        }),
        registerTurnPromoter: (promoter) => registry.register(promoter),
        createFanOut: Effect.fn("ExecutionBackend.createFanOut")((input) =>
          Effect.gen(function* () {
            const routePin = input.executionRoute
            const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin)
            const summaryModel = routePin?.compactionSummary
            const parentExecutionId = executionId(input.parentTurnId)
            const depth = childExecutionDepth(String(parentExecutionId)) + 1
            const executionToolOptions = yield* toolOptionsForExecution(String(parentExecutionId))
            const children = yield* Effect.forEach(input.children, (child) => {
              const profile = child.profile ?? "Task"
              const profileRoute =
                options.modelVariantPolicy === "fixed-selection" ? undefined : routeForProfile(routePin, profile)
              const inherited =
                options.modelVariantPolicy === "fixed-selection" ? options.selection : pinnedSelection(routePin.main)
              const requested =
                child.model === undefined ? undefined : resolveSpawnModel(routePin, inherited, child.model)
              if (child.model !== undefined && requested === undefined)
                return Effect.fail(BackendError.make({ message: `Model ${child.model} is not available` }))
              let selected = requested?.selection
              if (selected === undefined) {
                if (profileRoute !== undefined) selected = pinnedSelection(profileRoute)
                else if (profile === "Oracle") selected = options.oracleSelection ?? options.selection
                else selected = options.selection
              }
              const selectedRoute = requested === undefined ? profileRoute : routeForSelection(routePin, selected)
              const preset = resolve(profile, selected).preset
              const policy =
                selectedRoute === undefined
                  ? compactionPolicy(
                      profile === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                      options.compactionSummarySelection,
                    )
                  : pinnedCompactionPolicy(selectedRoute, summaryModel)
              const effort = requested?.effort ?? selectedRoute?.effort ?? routePin.main.effort
              return Effect.succeed({
                child_execution_id: makeChildExecutionId(input.parentTurnId, child.childId),
                address_id: addressId,
                input: [Content.text(child.prompt)],
                override: {
                  ...preset,
                  model: {
                    ...preset.model,
                    metadata: {
                      rika_execution_route: durableRoute,
                      rika_agent_depth: depth,
                      rika_reasoning_effort: effort,
                    },
                  },
                  tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, depth)),
                  ...(policy === undefined ? {} : { compaction_policy: policy }),
                },
                metadata: {
                  product_profile: profile,
                  steering_enabled: true,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: effort,
                  ...(input.workspace === undefined ? {} : { rika_workspace: input.workspace }),
                  rika_execution_route: durableRoute,
                },
              })
            })
            const state = yield* client.childRuns.createFanOut({
              fan_out_id: Ids.ChildFanOutId.make(input.fanOutId),
              parent_execution_id: parentExecutionId,
              children,
              max_concurrency: input.maxConcurrency,
              join:
                input.join === "quorum"
                  ? { _tag: "quorum", count: input.quorum ?? input.children.length }
                  : { _tag: input.join },
              created_at: input.createdAt,
            })
            return mapFanOut(state)
          }).pipe(Effect.mapError(error)),
        ),
        inspectFanOut: Effect.fn("ExecutionBackend.inspectFanOut")(function* (fanOutId) {
          const result = yield* client.childRuns
            .inspectFanOut({ fan_out_id: Ids.ChildFanOutId.make(fanOutId) })
            .pipe(Effect.mapError(error))
          return result.fan_out === null ? undefined : mapFanOut(result.fan_out)
        }),
        cancelFanOut: Effect.fn("ExecutionBackend.cancelFanOut")(function* (fanOutId, cancelledAt, reason) {
          const result = yield* client.childRuns
            .cancelFanOut({
              fan_out_id: Ids.ChildFanOutId.make(fanOutId),
              cancelled_at: cancelledAt,
              ...(reason === undefined ? {} : { reason }),
            })
            .pipe(Effect.mapError(error))
          return mapFanOut(result.fan_out)
        }),
        registerWorkflows: Effect.fn("ExecutionBackend.registerWorkflows")(function* () {
          return yield* Effect.forEach(definitions, (definition) => client.workflows.registerDefinition(definition), {
            concurrency: 1,
          }).pipe(
            Effect.map((records) =>
              records.map(({ record }) => ({
                name: record.definition.name,
                revision: record.revision,
                digest: record.digest,
              })),
            ),
            Effect.mapError(error),
          )
        }),
        startWorkflow: Effect.fn("ExecutionBackend.startWorkflow")(
          function* (name, runId, revision, ownerTurnId, workspace) {
            const result = yield* client.workflows
              .startRun({
                execution_id: workflowExecutionId(runId, ownerTurnId, workspace),
                workflow_definition_id: idFor(name),
                ...(revision === undefined ? {} : { revision }),
              })
              .pipe(Effect.mapError(error))
            return workflow(result)
          },
        ),
        inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (runId, ownerTurnId, workspace) {
          const result = yield* client.workflows
            .inspectRun(workflowExecutionId(runId, ownerTurnId, workspace))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (runId, ownerTurnId, workspace) {
          const result = yield* client.workflows
            .cancelRun(workflowExecutionId(runId, ownerTurnId, workspace))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (input) {
          const parentExecutionId = executionId(input.parentTurnId)
          const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(error))
          const routePin = executionRouteFromMetadata(parent?.agent_snapshot?.metadata)
          if (parent?.agent_snapshot === undefined || routePin === undefined)
            return yield* BackendError.make({ message: `Execution ${input.parentTurnId} has no pinned model route` })
          const route = routeForProfile(routePin, input.profile)
          const preset = resolve(input.profile, pinnedSelection(route)).preset
          const depth = childExecutionDepth(String(parentExecutionId)) + 1
          const executionToolOptions = yield* toolOptionsForExecution(String(parentExecutionId))
          const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(Effect.mapError(error))
          yield* client.childRuns
            .spawn({
              execution_id: parentExecutionId,
              child_execution_id: makeChildExecutionId(input.parentTurnId, input.childId),
              address_id: addressId,
              input: [Content.text(input.prompt)],
              instructions: preset.instructions,
              model: {
                ...preset.model,
                metadata: {
                  rika_execution_route: durableRoute,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: route.effort,
                },
              },
              tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, depth)),
              permissions: preset.permissions,
              compaction_policy: pinnedCompactionPolicy(route, routePin.compactionSummary),
              metadata: {
                product_profile: input.profile,
                steering_enabled: true,
                rika_agent_depth: depth,
                rika_reasoning_effort: route.effort,
                rika_execution_route: durableRoute,
              },
              wait: false,
            })
            .pipe(Effect.mapError(error))
          return {
            parentTurnId: input.parentTurnId,
            childId: input.childId,
            profile: input.profile,
            type: "accepted" as const,
          }
        }),
        start: Effect.fn(
          function* (input) {
            return yield* Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              const id = executionId(input.turnId)
              const permissionPolicy = yield* permissionPolicyFor(String(id))
              const executionToolOptions = yield* toolOptionsForExecution(String(id))
              const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(input.executionRoute)
              const metadata = {
                steering_enabled: true,
                rika_execution_id: String(id),
                rika_agent_depth: 0,
                rika_reasoning_effort: input.reasoningEffort ?? input.executionRoute.main.effort,
                rika_execution_route: durableRoute,
              }
              const rootCompaction =
                options.modelVariantPolicy === "fixed-selection"
                  ? compactionPolicy(options.compaction, options.compactionSummarySelection)
                  : pinnedCompactionPolicy(input.executionRoute.main, input.executionRoute.compactionSummary)
              const selection =
                options.modelVariantPolicy === "fixed-selection"
                  ? variantSelection(
                      options.selection,
                      input.reasoningEffort ?? options.defaultReasoningEffort,
                      input.fastMode === true,
                      options.modelVariantPolicy ?? "registration-key",
                    )
                  : pinnedSelection(input.executionRoute.main)
              const oracleSelection =
                options.modelVariantPolicy === "fixed-selection"
                  ? options.oracleSelection
                  : pinnedSelection(input.executionRoute.oracle)
              const agentRoutes =
                options.modelVariantPolicy === "fixed-selection" ? undefined : input.executionRoute.agents
              const agentModels =
                agentRoutes === undefined
                  ? {}
                  : {
                      Librarian: pinnedSelection(agentRoutes.librarian),
                      Painter: pinnedSelection(agentRoutes.painter),
                      Review: pinnedSelection(agentRoutes.review),
                      ReadThread: pinnedSelection(agentRoutes.readThread),
                    }
              const childDepth = 1
              const childRunPresets = Object.fromEntries(
                Object.entries(presets(selection, oracleSelection, agentModels)).map(([name, preset]) => {
                  const profile = name as AgentProfile
                  const profileRoute =
                    profile === "Task" ? input.executionRoute.main : routeForProfile(input.executionRoute, profile)
                  const effort =
                    profile === "Task"
                      ? (input.reasoningEffort ?? input.executionRoute.main.effort)
                      : profileRoute.effort
                  const policy =
                    options.modelVariantPolicy === "fixed-selection"
                      ? compactionPolicy(
                          profile === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                          options.compactionSummarySelection,
                        )
                      : pinnedCompactionPolicy(profileRoute, input.executionRoute.compactionSummary)
                  return [
                    name,
                    {
                      ...preset,
                      model: {
                        ...preset.model,
                        metadata: {
                          rika_execution_route: durableRoute,
                          rika_agent_depth: childDepth,
                          rika_reasoning_effort: effort,
                        },
                      },
                      tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, childDepth)),
                      ...(policy === undefined ? {} : { compaction_policy: policy }),
                      metadata: {
                        ...preset.metadata,
                        steering_enabled: true,
                        rika_agent_depth: childDepth,
                        rika_reasoning_effort: effort,
                        rika_execution_route: durableRoute,
                      },
                    },
                  ]
                }),
              )
              yield* Effect.logInfo("execution.starting").pipe(
                Effect.annotateLogs({
                  "rika.model.name": selection.model,
                  "rika.model.provider": selection.provider,
                }),
              )
              const auxiliaryTitle = input.sessionPurpose?._tag === "ThreadTitle"
              const agentName = `rika-${encodeURIComponent(input.turnId)}`
              const registered = yield* auxiliaryTitle
                ? client.agents.register({
                    id: agentId,
                    address: addressId,
                    name: agentName,
                    instructions: mainInstructions,
                    model: relayModelSelection(selection),
                    tools: [],
                    tool_execution: { concurrency: 4 },
                    permissions: [],
                    ...(permissionPolicy === undefined ? {} : { permission_rules: permissionPolicy }),
                    metadata,
                    ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
                  })
                : client.agents.register({
                    id: agentId,
                    address: addressId,
                    name: agentName,
                    instructions: mainInstructions,
                    model: relayModelSelection(selection),
                    tools: Object.values(toolkitFor(executionToolOptions).tools).map((tool) => ({ name: tool.name })),
                    tool_execution: { concurrency: 4 },
                    permissions: parentPermissions,
                    ...(permissionPolicy === undefined ? {} : { permission_rules: permissionPolicy }),
                    metadata,
                    ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
                    child_run_presets: childRunPresets,
                  })
              const start = client.executions
                .startByAgentDefinition({
                  root_address_id: addressId,
                  session_id: startSessionId(input),
                  agent_id: agentId,
                  agent_revision: registered.record.current_revision,
                  input: executionInput(input),
                  idempotency_key: input.turnId,
                  execution_id: id,
                  started_at: input.startedAt,
                  completed_at: input.startedAt,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.catchTag("ClientError", (startError) =>
                    client.executions.get(id).pipe(
                      Effect.matchEffect({
                        onFailure: () => Effect.fail(startError),
                        onSuccess: (existing) => (existing === undefined ? Effect.fail(startError) : Effect.void),
                      }),
                    ),
                  ),
                )
              const starter = yield* Effect.forkChild(start)
              yield* Effect.yieldNow
              const started = starter.pollUnsafe()
              if (started !== undefined) yield* Fiber.join(starter)
              else
                yield* Effect.raceFirst(
                  awaitExecutionAvailable(client, id, "Execution acceptance timed out"),
                  Fiber.join(starter),
                )
              yield* Clock.currentTimeMillis.pipe(
                Effect.flatMap((acceptedAt) =>
                  Effect.logInfo("execution.accepted").pipe(
                    Effect.annotateLogs("rika.duration.ms", acceptedAt - startedAt),
                  ),
                ),
              )
              return yield* followExecution(
                client,
                input.turnId,
                undefined,
                input.onEvent,
                true,
                undefined,
                input.eventScope,
              ).pipe(Effect.ensuring(Fiber.interrupt(starter)))
            }).pipe(
              Effect.tapCause((cause) =>
                Effect.logError("execution.start.failed").pipe(
                  Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                ),
              ),
              Effect.annotateLogs({
                "rika.execution.id": String(executionId(input.turnId)),
                "rika.thread.id": String(input.threadId),
                "rika.turn.id": String(input.turnId),
              }),
              Effect.mapError(error),
            )
          },
          (effect) => traceWithoutResult("ExecutionBackend.start", effect),
        ),
        follow: Effect.fn(
          function* (turnId, afterCursor, onEvent, reference, eventScope) {
            return yield* followExecution(client, turnId, afterCursor, onEvent, true, reference, eventScope).pipe(
              Effect.mapError(error),
            )
          },
          (effect) => traceWithoutResult("ExecutionBackend.follow", effect),
        ),
        replay: Effect.fn("ExecutionBackend.replay")(function* (turnId, afterCursor, reference) {
          return yield* client.executions
            .replay({
              execution_id: executionId(turnId, reference),
              ...(afterCursor === undefined ? {} : { after_cursor: afterCursor }),
            })
            .pipe(
              Effect.map((result) => {
                const events = result.events.map(event)
                return { turnId, status: statusFromEvents(events), events }
              }),
              Effect.mapError(error),
            )
        }),
        pageEvents: Effect.fn("ExecutionBackend.pageEvents")(function* (turnId, direction, cursor, limit, reference) {
          const cursorPage: { after_cursor?: string; before_cursor?: string } = {}
          if (cursor !== undefined) {
            if (direction === "forward") cursorPage.after_cursor = cursor
            else cursorPage.before_cursor = cursor
          }
          return yield* client.executions
            .pageEvents({
              execution_id: executionId(turnId, reference),
              direction,
              ...cursorPage,
              ...(limit === undefined ? {} : { limit }),
            })
            .pipe(
              Effect.map((result) => ({
                events: result.events.map(event),
                hasMore: result.has_more,
                ...(result.oldest_cursor === undefined ? {} : { oldestCursor: result.oldest_cursor }),
                ...(result.newest_cursor === undefined ? {} : { newestCursor: result.newest_cursor }),
              })),
              Effect.mapError(error),
            )
        }),
        cancel: Effect.fn("ExecutionBackend.cancel")(function* (turnId, cancelledAt, reference) {
          return yield* Effect.gen(function* () {
            const id = executionId(turnId, reference)
            yield* awaitExecutionAvailable(client, id, "Execution did not become available for cancellation")
            const accepted = yield* client.executions.cancel({
              execution_id: id,
              cancelled_at: cancelledAt,
            })
            const replay = yield* client.executions.replay({ execution_id: id })
            const events = replay.events.map(event)
            return { turnId, status: Status.make(accepted.status), events }
          }).pipe(Effect.mapError(error))
        }),
        inspect: Effect.fn("ExecutionBackend.inspect")(function* (turnId, reference) {
          const existing = yield* client.executions.get(executionId(turnId, reference))
          if (existing === undefined) return undefined
          return yield* client.executions.inspect(executionId(turnId, reference)).pipe(
            Effect.map((value) => ({
              turnId,
              status: Status.make(value.status),
              ...(value.last_event_cursor === undefined ? {} : { lastCursor: value.last_event_cursor }),
              waits: value.waiting_on.map((wait) => ({
                id: wait.wait_id,
                mode: wait.mode,
                createdAt: wait.created_at,
              })),
              pendingTools: value.pending_tool_calls.map((tool) => ({
                callId: tool.tool_call_id,
                name: tool.tool_name,
                input: tool.input,
                requestedAt: tool.requested_at,
              })),
              children: value.child_runs.map((child) => ({
                executionId: child.child_execution_id,
                status: Status.make(child.status),
              })),
            })),
          )
        }, Effect.mapError(error)),
        steer: Effect.fn("ExecutionBackend.steer")(function* (turnId, text, createdAt, reference) {
          const accepted = yield* client.executions
            .steer({
              execution_id: executionId(turnId, reference),
              kind: "steering",
              content: [Content.text(text)],
              created_at: createdAt,
            })
            .pipe(Effect.mapError(error))
          return {
            steeringMessageId: `${String(accepted.execution_id)}:${accepted.kind}:${accepted.sequence}`,
            sequence: accepted.sequence,
          }
        }),
        listApprovals: Effect.fn("ExecutionBackend.listApprovals")(function* (turnId, reference) {
          return yield* Effect.gen(function* () {
            const ids = yield* executionTreeIds(client, executionId(turnId, reference))
            const approvals = yield* Effect.forEach(ids, (execution) =>
              client.tools.listPendingApprovals({ execution_id: execution }),
            )
            return approvals.flatMap((result, index) =>
              result.approvals.map((approval) => ({
                waitId: approval.wait_id,
                executionId: String(ids[index]),
                callId: approval.tool_call_id,
                toolName: approval.tool_name,
                input: approval.input,
                requestedAt: approval.requested_at,
              })),
            )
          }).pipe(Effect.mapError(error))
        }),
        resolveToolApproval: Effect.fn("ExecutionBackend.resolveToolApproval")(
          function* (waitId, approved, resolvedAt, comment) {
            yield* client.tools
              .resolveApproval({
                wait_id: Ids.WaitId.make(waitId),
                approved,
                resolved_at: resolvedAt,
                ...(comment === undefined ? {} : { comment }),
              })
              .pipe(Effect.mapError(error))
          },
        ),
        resolvePermission: Effect.fn("ExecutionBackend.resolvePermission")(
          function* (waitId, answer, resolvedAt, reason) {
            yield* client.tools
              .resolvePermission({
                wait_id: Ids.WaitId.make(waitId),
                answer,
                resolved_at: resolvedAt,
                ...(reason === undefined ? {} : { reason }),
              })
              .pipe(Effect.mapError(error))
          },
        ),
      })
    }),
  )

export const layer = <
  AdditionalTools extends Record<string, Tool.Any> = {},
  RuntimeRequirements extends ToolRuntimeRequirements = never,
>(
  options: LayerOptions<AdditionalTools, RuntimeRequirements>,
): Layer.Layer<
  Service,
  BackendError | PlatformError.PlatformError | Runtime.AcquisitionError,
  Crypto.Crypto | ExternalToolRuntimeRequirements<RuntimeRequirements>
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sqliteModule = yield* Effect.tryPromise({
        try: () => import("@relayfx/sdk/sqlite"),
        catch: error,
      })
      const promoterRegistry = yield* ThreadHost.makeRegistry
      const promoterRegistryLayer = Layer.succeed(ThreadHost.Registry, promoterRegistry)
      const relayClient = yield* Deferred.make<Client.Interface>()
      {
        const { SQLite } = sqliteModule
        {
          const toolkit = toolkitFor(
            options.webSearchCredentialsForWorkspace === undefined
              ? options
              : {
                  ...options,
                  webSearchCredentials: Object.fromEntries(
                    WebSearch.providerRegistry.map((provider) => [provider.id, Redacted.make("")]),
                  ),
                },
          )
          const runnerToolkit = Toolkit.make(...Object.values(toolkit.tools), ThreadHost.promoteTurnTool)
          const toolOptionsForExecution = (execution: string) =>
            Effect.gen(function* () {
              const workspace =
                options.resolveWorkspace === undefined ? options.workspace : yield* options.resolveWorkspace(execution)
              const credentials =
                options.webSearchCredentialsForWorkspace === undefined
                  ? options.webSearchCredentials
                  : yield* options.webSearchCredentialsForWorkspace(workspace)
              return { ...options, webSearchCredentials: credentials ?? {} }
            })
          const delegation = Effect.fn("ExecutionBackend.delegateAgent")(function* (
            toolName: AgentTools.DelegationToolName,
            profile: AgentProfile,
            input: AgentTools.TaskInput | { readonly prompt: string },
          ) {
            const call = yield* RelayToolRuntime.ToolCallInfo
            const parentDepth = childExecutionDepth(String(call.executionId))
            if (!delegationAvailableAtDepth(parentDepth)) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: `Agent delegation is unavailable at depth ${parentDepth}`,
              })
            }
            const client = yield* Deferred.await(relayClient)
            const parent = yield* client.executions
              .get(call.executionId)
              .pipe(
                Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
              )
            const snapshot = parent?.agent_snapshot
            const routePin =
              parent === undefined
                ? undefined
                : yield* pinnedRouteForExecution(client, parent).pipe(
                    Effect.mapError((cause) =>
                      AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) }),
                    ),
                  )
            if (snapshot === undefined) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: `Execution ${call.executionId} does not have an agent snapshot`,
              })
            }
            if (routePin === undefined) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: "The parent execution does not have a pinned model route",
              })
            }
            const parentSelection = modelSelection(snapshot.model)
            const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            const executionToolOptions = yield* toolOptionsForExecution(String(call.executionId)).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            const calls = [
              {
                callId: String(call.call.id),
                prompt: input.prompt,
                ...(profile === "Task" && "model" in input && input.model !== undefined ? { model: input.model } : {}),
              },
            ]
            const children = yield* Effect.forEach(calls, (childCall) => {
              const base = {
                child_execution_id: makeChildExecutionId(String(call.executionId), childCall.callId),
                address_id: addressId,
                input: [Content.text(childCall.prompt)],
              }
              if (childCall.model === undefined && snapshot.child_run_presets?.[profile] !== undefined) {
                return Effect.succeed(
                  buildChildRunInput(base, {
                    _tag: "preset",
                    presetName: profile,
                  }),
                )
              }
              let selected:
                | {
                    readonly selection: ModelRegistry.ModelSelection
                    readonly effort: string
                  }
                | undefined
              if (profile === "Task") selected = resolveSpawnModel(routePin, parentSelection, childCall.model)
              else {
                const profileRoute = routeForProfile(routePin, profile)
                let selection: ModelRegistry.ModelSelection
                if (options.modelVariantPolicy !== "fixed-selection") selection = pinnedSelection(profileRoute)
                else if (profile === "Oracle") selection = options.oracleSelection ?? options.selection
                else selection = options.selection
                selected = {
                  selection,
                  effort: profileRoute.effort,
                }
              }
              if (selected === undefined) {
                return Effect.fail(
                  AgentTools.AgentToolError.make({
                    tool: toolName,
                    message: `Model ${childCall.model} is not available in this execution's registered routes`,
                  }),
                )
              }
              const childDepth = parentDepth + 1
              const preset = resolve(profile, selected.selection).preset
              const selectedRoute = routeForSelection(routePin, selected.selection)
              const policy =
                selectedRoute === undefined
                  ? snapshot.compaction_policy
                  : pinnedCompactionPolicy(selectedRoute, routePin.compactionSummary)
              return Effect.succeed(
                buildChildRunInput(base, {
                  _tag: "override",
                  definition: {
                    instructions: preset.instructions,
                    model: {
                      ...relayModelSelection(selected.selection),
                      metadata: {
                        rika_execution_route: durableRoute,
                        rika_agent_depth: childDepth,
                        rika_reasoning_effort: selected.effort,
                      },
                    },
                    tool_names: availableTools(executionToolOptions, toolsAtDepth(preset.tool_names, childDepth)),
                    permissions: preset.permissions,
                    ...(policy === undefined ? {} : { compaction_policy: policy }),
                    metadata: {
                      product_profile: profile,
                      steering_enabled: true,
                      rika_agent_depth: childDepth,
                      rika_reasoning_effort: selected.effort,
                      rika_execution_route: durableRoute,
                    },
                  },
                }),
              )
            })
            yield* Effect.forEach(
              children,
              (child) =>
                client.childRuns.spawn({
                  execution_id: call.executionId,
                  ...child,
                  wait: false,
                }),
              { discard: true },
            ).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            const currentCall = calls.find((childCall) => childCall.callId === String(call.call.id))
            const current =
              currentCall === undefined
                ? undefined
                : children.find(
                    (child) =>
                      child.child_execution_id === makeChildExecutionId(String(call.executionId), currentCall.callId),
                  )
            if (current === undefined) {
              return yield* AgentTools.AgentToolError.make({
                tool: toolName,
                message: `The child for tool call ${call.call.id} is not in its fan-out batch`,
              })
            }
            const result = yield* awaitChildResult(client, String(current.child_execution_id)).pipe(
              Effect.mapError((cause) => AgentTools.AgentToolError.make({ tool: toolName, message: String(cause) })),
            )
            return {
              childExecutionId: String(current.child_execution_id),
              status: result.status,
              output: [...result.output],
            }
          })
          const runDelegation = delegation as unknown as (
            toolName: AgentTools.DelegationToolName,
            profile: AgentProfile,
            input: AgentTools.TaskInput | { readonly prompt: string },
          ) => Effect.Effect<AgentTools.Result, AgentTools.AgentToolError>
          const delegationHandlerLayer: Layer.Layer<Tool.HandlersFor<typeof AgentTools.modelToolkit.tools>> =
            AgentTools.modelToolkit.toLayer({
              task: (input) => runDelegation("task", "Task", input),
              oracle: (input) => runDelegation("oracle", "Oracle", input),
              librarian: (input) => runDelegation("librarian", "Librarian", input),
              review: (input) => runDelegation("review", "Review", input),
            })
          const handlerLayer = Layer.mergeAll(
            options.additionalHandlerLayer === undefined
              ? RikaToolRuntime.handlerLayer
              : Layer.merge(RikaToolRuntime.handlerLayer, options.additionalHandlerLayer),
            ThreadHost.handlerLayer(promoterRegistry),
            delegationHandlerLayer,
          )
          const registrationEffects = [
            ...registrationsFor(options).map((registration) => Effect.succeed(registration)),
            ThreadHost.hostRegistration,
          ]
          const relayModelContext = yield* Layer.build(
            ModelHub.layerFromRegistrationEffects(
              registrationEffects as unknown as ReadonlyArray<
                Effect.Effect<Parameters<ModelHub.Interface["modelRegistry"]["register"]>[0]["registration"]>
              >,
            ),
          ).pipe(Effect.mapError(error))
          const modelRegistry = Context.get(relayModelContext, ModelHub.Service).modelRegistry
          const languageModelLayer = Layer.succeedContext(relayModelContext)
          const sharedModelRegistryLayer = Layer.succeed(ModelRegistry.ModelRegistry, modelRegistry)
          const rikaToolRuntimeLayer =
            options.toolRuntimeLayerForWorkspace !== undefined && options.resolveWorkspace !== undefined
              ? routedToolRuntimeLayer(options.toolRuntimeLayerForWorkspace, options.resolveWorkspace)
              : (options.toolRuntimeLayer ??
                RikaToolRuntime.layer(options.workspace).pipe(
                  Layer.catchCause((cause) =>
                    Layer.effectContext(Effect.fail(BackendError.make({ message: Cause.pretty(cause) }))),
                  ),
                ))
          const credentials = options.webSearchCredentials ?? {}
          const search = webSearchFactories(credentials)
          const readPageCredential = WebSearch.configuredReadPageCredential(credentials)
          if (search.unsupportedIds.length > 0)
            yield* Effect.logWarning("web_search.unsupported_provider").pipe(
              Effect.annotateLogs("rika.web_search.provider_ids", search.unsupportedIds.join(",")),
            )
          const toolRuntimeLayer = RelayToolRuntime.layerFromToolkit(runnerToolkit, (tool) => ({
            needsApproval:
              tool.name === ThreadHost.promoteTurnTool.name
                ? false
                : (options.toolNeedsApproval?.(tool.name) ?? ToolCatalog.get(tool.name)?.permission === "ask"),
          })).pipe(
            Layer.provide(handlerLayer),
            Layer.provide(
              rikaToolRuntimeLayer.pipe(
                Layer.provide(MediaAnalyzer.layer(options.selection)),
                Layer.provide(sharedModelRegistryLayer),
                Layer.provide(
                  Layer.mergeAll(
                    WebSearch.factoryLayer(search.factories),
                    ReadWebPage.layer(readPageCredential === undefined ? {} : { apiKey: readPageCredential }),
                  ).pipe(Layer.provide(FetchHttpClient.layer)),
                ),
              ),
            ),
          )
          const childResult = (client: Client.Interface, childId: string) => {
            const childExecutionId = Ids.ExecutionId.make(childId)
            return client.executions.stream({ execution_id: childExecutionId }).pipe(
              Stream.takeUntil(
                (item) =>
                  item.type === "execution.completed" ||
                  item.type === "execution.failed" ||
                  item.type === "execution.cancelled",
              ),
              Stream.runCollect,
              Effect.map((events) => {
                const terminal = events.findLast(
                  (executionEvent) =>
                    executionEvent.type === "execution.completed" ||
                    executionEvent.type === "execution.failed" ||
                    executionEvent.type === "execution.cancelled",
                )
                const modelOutput = events.findLast(
                  (executionEvent) => executionEvent.type === "model.output.completed",
                )
                let status: "completed" | "cancelled" | "failed" = "failed"
                if (terminal?.type === "execution.completed") status = "completed"
                else if (terminal?.type === "execution.cancelled") status = "cancelled"
                return {
                  status,
                  output:
                    terminal?.content === undefined || terminal.content.length === 0
                      ? (modelOutput?.content ?? [])
                      : terminal.content,
                }
              }),
            )
          }
          const fanOutHandlers = Layer.succeed(
            ChildFanOutHost.Service,
            ChildFanOutHost.Service.of({
              execute: (child, fanOutState, idempotencyKey) =>
                Deferred.await(relayClient).pipe(
                  Effect.flatMap((client) =>
                    Effect.gen(function* () {
                      const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
                      const override = child.override ?? {}
                      const childToolkit = Toolkit.make(
                        ...Object.values(toolkit.tools).filter(
                          (tool) => override.tool_names === undefined || override.tool_names.includes(tool.name),
                        ),
                      )
                      const metadata = {
                        steering_enabled: true,
                        ...override.metadata,
                        ...child.metadata,
                        rika_execution_id: String(child.child_execution_id),
                      }
                      const childSelection =
                        override.model === undefined
                          ? options.selection
                          : {
                              provider: override.model.provider,
                              model: override.model.model,
                              ...(override.model.registration_key === undefined
                                ? {}
                                : {
                                    registrationKey: override.model.registration_key,
                                  }),
                            }
                      const childAgentId = fanOutAgentId(fanOutState.fan_out_id, child.child_execution_id)
                      const registered = yield* client.agents.register({
                        id: childAgentId,
                        address: child.address_id,
                        name: `rika-fan-out-${String(child.child_execution_id)}`,
                        ...(override.instructions === undefined ? {} : { instructions: override.instructions }),
                        model: relayModelSelection(childSelection),
                        tools: Object.values(childToolkit.tools).map((tool) => ({ name: tool.name })),
                        permissions:
                          override.permissions === undefined
                            ? parentPermissions
                            : override.permissions.map((name: string) => ({ name, value: true })),
                        ...(options.permissionPolicy === undefined
                          ? {}
                          : { permission_rules: options.permissionPolicy }),
                        ...(override.output_schema_ref === undefined
                          ? {}
                          : { output_schema_ref: override.output_schema_ref }),
                        metadata,
                        ...(override.compaction_policy === undefined
                          ? {}
                          : { compaction_policy: override.compaction_policy }),
                      })
                      yield* client.executions.startByAgentDefinition({
                        root_address_id: child.address_id,
                        session_id: childSessionId(child.child_execution_id),
                        agent_id: childAgentId,
                        agent_revision: registered.record.current_revision,
                        execution_id: Ids.ExecutionId.make(String(child.child_execution_id)),
                        ...(child.input === undefined ? {} : { input: child.input }),
                        idempotency_key: idempotencyKey,
                        started_at: startedAt,
                        completed_at: startedAt,
                        metadata: {
                          child_execution_id: child.child_execution_id,
                          fan_out_id: fanOutState.fan_out_id,
                          ...child.metadata,
                        },
                      })
                      return yield* childResult(client, String(child.child_execution_id))
                    }),
                  ),
                  Effect.mapError((cause) => ChildFanOutHost.HandlerError.make({ message: String(cause) })),
                ),
              cancel: (childExecutionId) =>
                Deferred.await(relayClient).pipe(
                  Effect.flatMap((client) =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((cancelledAt) =>
                        client.executions.cancel({
                          execution_id: Ids.ExecutionId.make(String(childExecutionId)),
                          cancelled_at: cancelledAt,
                        }),
                      ),
                      Effect.asVoid,
                      Effect.mapError((cause) => ChildFanOutHost.HandlerError.make({ message: String(cause) })),
                    ),
                  ),
                ),
            }),
          )
          const workflowHandlers = Layer.succeed(
            WorkflowDefinitionHost.Service,
            WorkflowDefinitionHost.Service.of({
              child: (parentId, operation, context) => {
                const parentExecutionId = String(parentId)
                const childId = makeChildExecutionId(parentExecutionId, String(operation.id))
                const grounded = "address_id" in operation
                const profileName = grounded ? String(operation.preset_name) : "Task"
                const availablePresets = presets(options.selection, options.oracleSelection)
                const preset = availablePresets[profileName] ?? availablePresets.Task!
                const childSelection = {
                  provider: preset.model.provider,
                  model: preset.model.model,
                  ...(preset.model.registration_key === undefined
                    ? {}
                    : { registrationKey: preset.model.registration_key }),
                }
                const childAgentId = Ids.AgentId.make(
                  `agent:rika:workflow:${encodeURIComponent(parentExecutionId)}:${String(operation.id)}`,
                )
                const policy = compactionPolicy(
                  profileName === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                  options.compactionSummarySelection,
                )
                return Deferred.await(relayClient).pipe(
                  Effect.flatMap((client) =>
                    Effect.gen(function* () {
                      const startedAt = yield* Clock.currentTimeMillis
                      const executionToolOptions = yield* toolOptionsForExecution(parentExecutionId)
                      const childToolkit = Toolkit.make(
                        ...Object.values(toolkitFor(executionToolOptions).tools).filter((tool) =>
                          preset.tool_names.includes(tool.name),
                        ),
                      )
                      const encodedInput = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
                        operation.input ?? {},
                      )
                      const registered = yield* client.agents.register({
                        id: childAgentId,
                        address: grounded ? operation.address_id : addressId,
                        name: `rika-workflow-${String(childId)}`,
                        instructions: preset.instructions,
                        model: relayModelSelection(childSelection),
                        tools: Object.values(childToolkit.tools).map((tool) => ({ name: tool.name })),
                        permissions: preset.permissions.map((name) => ({ name, value: true })),
                        ...(options.permissionPolicy === undefined
                          ? {}
                          : { permission_rules: options.permissionPolicy }),
                        metadata: {
                          ...preset.metadata,
                          steering_enabled: true,
                          rika_execution_id: String(childId),
                        },
                        ...(policy === undefined ? {} : { compaction_policy: policy }),
                      })
                      yield* client.executions
                        .startByAgentDefinition({
                          root_address_id: grounded ? operation.address_id : addressId,
                          session_id: childSessionId(childId),
                          agent_id: childAgentId,
                          agent_revision: registered.record.current_revision,
                          execution_id: Ids.ExecutionId.make(String(childId)),
                          input: [Content.text(encodedInput)],
                          idempotency_key: context.idempotency_key,
                          started_at: startedAt,
                          completed_at: startedAt,
                          metadata: {
                            parent_execution_id: parentId,
                            child_execution_id: childId,
                            workflow_operation_id: operation.id,
                          },
                        })
                        .pipe(
                          Effect.catchTag("ClientError", (startError) =>
                            client.executions
                              .get(Ids.ExecutionId.make(String(childId)))
                              .pipe(
                                Effect.flatMap((existing) =>
                                  existing === undefined ? Effect.fail(startError) : Effect.succeed(existing),
                                ),
                              ),
                          ),
                        )
                      return (yield* childResult(client, String(childId))).output
                    }),
                  ),
                  Effect.mapError((cause) => WorkflowDefinitionHost.HandlerError.make({ message: String(cause) })),
                )
              },
              approval: (_parentId, operation) => Effect.succeed({ approved: true, prompt: operation.prompt }),
              timer: (_parentId, operation) => Effect.sleep(`${operation.duration_ms} millis`),
              branch: () => Effect.succeed(true),
              structuredCompletion: (_schema, value) => Effect.succeed(value ?? null),
            }),
          )
          const runtimeLayer = Runtime.layerEmbedded({
            database: SQLite.database({ filename: options.filename }),
            languageModelLayer,
            toolRuntimeLayer,
            blobStoreLayer: DataBlobStore.layer,
            childFanOutHostLayer: fanOutHandlers,
            workflowDefinitionHostLayer: workflowHandlers,
          })
          return layerFromClient({
            ...options,
            onClientReady: (client) => Deferred.complete(relayClient, Effect.succeed(client)).pipe(Effect.asVoid),
            registerModels: (registrations) =>
              Effect.forEach(
                registrations,
                (registration) =>
                  modelRegistry.register({ registration: withResilience(registration, options.modelResilience) }),
                { discard: true },
              ),
          }).pipe(Layer.provide(runtimeLayer), Layer.provide(promoterRegistryLayer))
        }
      }
    }),
  )
