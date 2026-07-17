import { Agent, type Compaction, ModelRegistry, ModelResilience, type Permissions } from "@batonfx/core"
import { Catalog as ToolCatalog, ParallelSearch, ReadWebPage, Runtime as RikaToolRuntime } from "@rika/tools"
import {
  Client,
  Content,
  type Entity,
  type Execution,
  Ids,
  Runtime,
  ToolRuntime as RelayToolRuntime,
} from "@relayfx/sdk"
import type {
  ChildFanOutRuntime as ChildFanOutRuntimeModule,
  WorkflowDefinitionRuntime as WorkflowDefinitionRuntimeModule,
} from "@relayfx/sdk/sqlite"
import { Session as RelaySession } from "@relayfx/sdk/ai"
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  Function,
  Layer,
  LayerMap,
  Option,
  Queue,
  Redacted,
  Schedule,
  Schema,
  Semaphore,
  Scope,
  Stream,
} from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import {
  type AgentProfile,
  BackendError,
  Event,
  type ExecutionRoutePin,
  type PromptPart,
  Service,
  Status,
} from "./execution-contract"
import {
  childRunSpawnPermission,
  outputSchemaRegistrations,
  parentPermissions,
  presets,
  resolve,
  subagentHandoffTargets,
} from "./agent-profiles"
import * as MediaAnalyzer from "./media-analyzer"
import * as ThreadHost from "./thread-host"
import { definitions, idFor } from "./workflow-definitions"

export type ModelVariantPolicy = "registration-key" | "fixed-selection"

type ToolRuntimeRequirements =
  ReturnType<typeof RikaToolRuntime.layer> extends Layer.Layer<infer _A, infer _E, infer R> ? R : never

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
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
  readonly parallelApiKey?: Redacted.Redacted<string>
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
  readonly additionalToolkit?: Toolkit.Toolkit<AdditionalTools>
  readonly additionalHandlerLayer?: Layer.Layer<Tool.HandlersFor<AdditionalTools>, BackendError, never>
  readonly toolRuntimeLayer?: Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements>
  readonly toolRuntimeLayerForWorkspace?: (
    workspace: string,
  ) => Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements>
  readonly resolveWorkspace?: (executionId: string) => Effect.Effect<string, BackendError>
  readonly toolNeedsApproval?: (name: string) => boolean
}

export const routedToolRuntimeLayer: {
  <E, R>(
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ): (
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
  ) => Layer.Layer<RikaToolRuntime.Service, E, R>
  <E, R>(
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ): Layer.Layer<RikaToolRuntime.Service, E, R>
} = Function.dual(
  2,
  <E, R>(
    layerForWorkspace: (workspace: string) => Layer.Layer<RikaToolRuntime.Service, E, R>,
    resolveWorkspace: (executionId: string) => Effect.Effect<string, BackendError>,
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const runtimes = yield* LayerMap.make(layerForWorkspace, { idleTimeToLive: "1 minute" })
        const run = ((request: RikaToolRuntime.Request) =>
          Effect.scoped(
            Effect.gen(function* () {
              const call = yield* RelayToolRuntime.ToolCallInfo
              const workspace = yield* resolveWorkspace(String(call.executionId))
              const context = yield* runtimes.contextEffect(workspace)
              const runtime = Context.get(context, RikaToolRuntime.Service)
              const startedAt = yield* Clock.currentTimeMillis
              yield* Effect.logInfo("tool.started")
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
                          "rika.failure.kind": failureKind(cause),
                        }),
                      ),
                    ),
                  ),
                ),
                Effect.annotateLogs({
                  "rika.execution.id": String(call.executionId),
                  "rika.tool.call.id": String(call.call.id),
                  "rika.tool.name": String(call.call.name),
                }),
              )
            }),
          ).pipe(
            Effect.mapError((cause) =>
              Schema.is(RikaToolRuntime.ToolError)(cause)
                ? cause
                : RikaToolRuntime.ToolError.make({ tool: request._tag, message: String(cause) }),
            ),
          )) as RikaToolRuntime.Interface["run"]
        return Layer.succeed(RikaToolRuntime.Service, RikaToolRuntime.Service.of({ run }))
      }),
    ),
)

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

const executionNamespaceFromSessionEntry = (value: string) => /^.+:entry:(.+):\d+:complete:\d+:\d+$/.exec(value)?.[1]

const currentExecutionNamespace = (fallback: string) =>
  Effect.serviceOption(RelaySession.SessionStore).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(fallback),
        onSome: (session) =>
          session.path().pipe(
            Effect.map((entries) => executionNamespaceFromSessionEntry(String(entries.at(-1)?.id ?? "")) ?? fallback),
            Effect.orElseSucceed(() => fallback),
          ),
      }),
    ),
  )

const toolCallPrefix = (namespace: string) => `rika:${encodeURIComponent(namespace)}:`
const namespaceToolCallId = (namespace: string, id: string) => {
  const prefix = toolCallPrefix(namespace)
  return id.startsWith(prefix) ? id : `${prefix}${id}`
}
const providerToolCallId = (namespace: string, id: string) => {
  const prefix = toolCallPrefix(namespace)
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

const childExecutionIdFromEvent = (item: Execution.ExecutionEvent) => {
  const value = item.child_execution_id ?? item.data?.child_execution_id
  return typeof value === "string" && value.length > 0 ? value : undefined
}

const mapPromptPart = (namespace: string, part: Prompt.Part): Prompt.Part => {
  if (part.type === "tool-call" || part.type === "tool-result")
    return { ...part, id: providerToolCallId(namespace, part.id) }
  if (part.type === "tool-approval-request")
    return { ...part, toolCallId: providerToolCallId(namespace, part.toolCallId) }
  return part
}

const providerPrompt = (namespace: string, input: Prompt.RawInput) => {
  const prompt = Prompt.make(input)
  return Prompt.fromMessages(
    prompt.content.map((message) =>
      typeof message.content === "string"
        ? message
        : (Object.assign({}, message, {
            content: message.content.map((part) => mapPromptPart(namespace, part)),
          }) as Prompt.Message),
    ),
  )
}

const mapResponsePart = <A extends Response.AnyPart>(namespace: string, part: A): A => {
  if (
    part.type === "tool-params-start" ||
    part.type === "tool-params-delta" ||
    part.type === "tool-params-end" ||
    part.type === "tool-call" ||
    part.type === "tool-result"
  )
    return { ...part, id: namespaceToolCallId(namespace, part.id) } as A
  if (part.type === "tool-approval-request")
    return { ...part, toolCallId: namespaceToolCallId(namespace, part.toolCallId) } as A
  return part
}

const namespaceLanguageModel = (model: LanguageModel.Service, fallback: string): LanguageModel.Service => ({
  ...model,
  generateText: ((options: any) =>
    currentExecutionNamespace(fallback).pipe(
      Effect.flatMap((namespace) =>
        model
          .generateText({ ...options, prompt: providerPrompt(namespace, options.prompt) })
          .pipe(
            Effect.map(
              (result) =>
                new LanguageModel.GenerateTextResponse(result.content.map((part) => mapResponsePart(namespace, part))),
            ),
          ),
      ),
    )) as LanguageModel.Service["generateText"],
  generateObject: ((options: any) =>
    currentExecutionNamespace(fallback).pipe(
      Effect.flatMap((namespace) =>
        (
          model.generateObject as (
            options: any,
          ) => Effect.Effect<LanguageModel.GenerateObjectResponse<Record<string, Tool.Any>, unknown>, never, never>
        )({ ...options, prompt: providerPrompt(namespace, options.prompt) }).pipe(
          Effect.map(
            (result) =>
              new LanguageModel.GenerateObjectResponse(
                result.value,
                result.content.map((part) => mapResponsePart(namespace, part)),
              ),
          ),
        ),
      ),
    )) as LanguageModel.Service["generateObject"],
  streamText: ((options: any) =>
    Stream.unwrap(
      currentExecutionNamespace(fallback).pipe(
        Effect.map((namespace) =>
          model
            .streamText({ ...options, prompt: providerPrompt(namespace, options.prompt) })
            .pipe(Stream.map((part) => mapResponsePart(namespace, part))),
        ),
      ),
    )) as LanguageModel.Service["streamText"],
})

const withNamespacedLanguageModel = <A, E, R>(
  fallback: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | LanguageModel.LanguageModel> =>
  LanguageModel.LanguageModel.pipe(
    Effect.flatMap((model) =>
      effect.pipe(Effect.provideService(LanguageModel.LanguageModel, namespaceLanguageModel(model, fallback))),
    ),
  )

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

function closeRelayClientRequirements<A, E, R>(
  layer: Layer.Layer<A, E, R | Client.RuntimeRequirements>,
): Layer.Layer<A, E, R>
function closeRelayClientRequirements<A, E, R>(layer: Layer.Layer<A, E, R>) {
  return layer
}

const relayModelSelection = (selection: ModelRegistry.ModelSelection) => ({
  provider: selection.provider,
  model: selection.model,
  ...(selection.registrationKey === undefined ? {} : { registration_key: selection.registrationKey }),
})

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

const toolkitFor = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit">,
) =>
  options.additionalToolkit === undefined
    ? RikaToolRuntime.toolkit
    : Toolkit.make(...Object.values(RikaToolRuntime.toolkit.tools), ...Object.values(options.additionalToolkit.tools))

export const remoteToolOptions = (parallelApiKey: Redacted.Redacted<string> | undefined) =>
  parallelApiKey === undefined ? {} : { apiKey: parallelApiKey }

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
const executionId = (turnId: string) =>
  Ids.ExecutionId.make(turnId.startsWith("child:") || turnId.startsWith("execution:") ? turnId : `execution:${turnId}`)
const makeChildExecutionId = (parentTurnId: string, childId: string) =>
  Ids.ChildExecutionId.make(`child:${encodeURIComponent(parentTurnId)}:${childId}`)
const workflowExecutionId = (runId: string, ownerTurnId?: string) =>
  Ids.ExecutionId.make(
    ownerTurnId === undefined
      ? `workflow:${runId}`
      : `workflow:turn:${encodeURIComponent(ownerTurnId)}:run:${encodeURIComponent(runId)}`,
  )
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
const belongsToWorkflow = (value: string): boolean => {
  if (value.startsWith("workflow:")) return true
  const parent = childParentExecutionId(value)
  return parent === undefined ? false : belongsToWorkflow(parent)
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
const sessionId = (threadId: string) => Ids.SessionId.make(`session:${threadId}`)
const childSessionId = (childExecutionId: Ids.ChildExecutionId) =>
  Ids.SessionId.make(`session:child:${String(childExecutionId)}`)
const isBackendError = Schema.is(BackendError)
const error = (cause: unknown): BackendError =>
  isBackendError(cause) ? cause : BackendError.make({ message: String(cause) })
const executionInput = (input: { readonly prompt: string; readonly promptParts?: ReadonlyArray<PromptPart> }) =>
  input.promptParts?.map((part) =>
    part.type === "text"
      ? Content.text(part.text)
      : {
          type: "blob-reference" as const,
          uri: `data:${part.mediaType};base64,${part.data}`,
          media_type: part.mediaType,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
        },
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
  return {
    runId: attached?.runId ?? execution.replace(/^workflow:/, ""),
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
      const inspection = yield* client.inspectExecution(current)
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
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("execution.follow.started")
      const rootExecutionId = executionId(turnId)
      const events: Array<Event> = []
      const followed = new Set<string>()
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
            client.followExecution({
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
              const terminal =
                mapped.type === "execution.completed"
                  ? Status.make("completed")
                  : mapped.type === "execution.failed"
                    ? Status.make("failed")
                    : mapped.type === "execution.cancelled"
                      ? Status.make("cancelled")
                      : undefined
              const inspectActionable =
                stopAtActionableWait && isActionableWait(mapped) && typeof mapped.data?.wait_id === "string"
                  ? client
                      .inspectExecution(execution)
                      .pipe(
                        Effect.map((inspection) =>
                          inspection.waiting_on.some((wait) => wait.wait_id === mapped.data?.wait_id),
                        ),
                      )
                  : Effect.succeed(false)
              return Effect.gen(function* () {
                if (root || spawnedChild !== undefined) {
                  yield* Queue.offer(updates, {
                    _tag: "event",
                    event: mapped,
                    actionable: false,
                    ...(terminal === undefined ? {} : { terminal }),
                  })
                }
                if (spawnedChild !== undefined) yield* launch(Ids.ExecutionId.make(spawnedChild), false)
                const actionable = yield* inspectActionable
                if (actionable && !root) yield* Queue.offer(updates, { _tag: "event", event: mapped, actionable: true })
                if (actionable && root)
                  yield* Queue.offer(updates, { _tag: "stopped", status: "waiting", actionable: true })
                return terminal === undefined && !actionable
              })
            },
          )
        return Effect.gen(function* () {
          const inspection = yield* client.inspectExecution(execution).pipe(
            Effect.retry({
              while: isExecutionNotFound,
              schedule: Schedule.spaced("10 millis"),
              times: 100,
            }),
          )
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
                  error: BackendError.make({ message: Cause.pretty(cause) }),
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
        if (update.actionable) {
          stoppedAtActionableWait = true
          stoppedStatus = "waiting"
        } else if (update.terminal !== undefined) stoppedStatus = update.terminal
      }
      const status = stoppedStatus ?? statusFromEvents(events)
      yield* Effect.forEach(
        events.filter((item) => observableEventTypes.has(item.type)),
        (item) =>
          Effect.logInfo("execution.event").pipe(
            Effect.annotateLogs({
              "rika.event.cursor": item.cursor,
              "rika.event.sequence": item.sequence,
              "rika.event.type": item.type,
            }),
          ),
        { discard: true },
      )
      const completedAt = yield* Clock.currentTimeMillis
      yield* Effect.logInfo("execution.follow.completed").pipe(
        Effect.annotateLogs({
          "rika.duration.ms": completedAt - startedAt,
          "rika.event.count": events.length,
          "rika.execution.status": status,
        }),
      )
      return {
        turnId,
        status:
          status === "running" || status === "queued"
            ? stoppedAtActionableWait
              ? Status.make("waiting")
              : status
            : status,
        events,
      }
    }),
  ).pipe(
    Effect.tapCause((cause) =>
      Effect.logError("execution.follow.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
    ),
    Effect.annotateLogs({
      "rika.execution.id": String(executionId(turnId)),
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
    | "defaultReasoningEffort"
    | "modelVariantPolicy"
  > & {
    readonly registerModels?: (registrations: ReadonlyArray<ModelRegistry.Registration>) => Effect.Effect<void>
  },
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* Client.Service
      const registry =
        Option.getOrUndefined(yield* Effect.serviceOption(ThreadHost.Registry)) ?? (yield* ThreadHost.makeRegistry)
      const hostInstances = new Map<string, Entity.Instance>()
      const hostReady = yield* Effect.cached(
        Effect.gen(function* () {
          yield* client.registerAgent({
            id: ThreadHost.hostAgentId,
            agent: Agent.make("rika-thread-host", {
              instructions: "Promote pending Rika turns delivered to this thread host.",
              model: ThreadHost.hostSelection,
              toolkit: ThreadHost.toolkit,
            }),
            permissions: [
              { name: "relay.inbox.wait", value: true },
              { name: "relay.inbox.send", value: true },
            ],
            max_wait_turns: ThreadHost.hostMaxWaitTurns,
            metadata: { steering_enabled: false, inbox_enabled: true },
          })
          yield* client.registerEntityKind({
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
        const existing = yield* client.getEntity({
          kind: ThreadHost.entityKind,
          key: Ids.EntityKey.make(threadId),
        })
        if (existing?.status === "active") {
          const inspection = yield* client.inspectExecution(existing.execution_id)
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
            yield* client.destroyEntity({
              kind: ThreadHost.entityKind,
              key: Ids.EntityKey.make(threadId),
              reason: "thread host execution ended; recreating a fresh generation",
              destroyed_at: now,
            })
            hostInstances.delete(threadId)
          }
        }
        const instance = yield* client.getOrCreateEntity({
          kind: ThreadHost.entityKind,
          key: Ids.EntityKey.make(threadId),
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
        instance: Entity.Instance,
        now: number,
      ) {
        const outcome = yield* Effect.gen(function* () {
          const inspection = yield* client.inspectExecution(instance.execution_id)
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
        yield* client.destroyEntity({
          kind: ThreadHost.entityKind,
          key: Ids.EntityKey.make(threadId),
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
                yield* client.send({
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
            const routeForProfile = (profile: AgentProfile) => {
              if (options.modelVariantPolicy === "fixed-selection") return undefined
              if (profile === "Oracle") return routePin.oracle
              if (routePin.agents === undefined) return routePin.main
              if (profile === "Librarian") return routePin.agents.librarian
              if (profile === "Painter") return routePin.agents.painter
              if (profile === "Review") return routePin.agents.review
              if (profile === "ReadThread") return routePin.agents.readThread
              return routePin.agents.task
            }
            const state = yield* client.createChildFanOut({
              fan_out_id: Ids.ChildFanOutId.make(input.fanOutId),
              parent_execution_id: executionId(input.parentTurnId),
              children: input.children.map((child) => {
                const profile = child.profile ?? "Task"
                const profileRoute = routeForProfile(profile)
                const preset = resolve(
                  profile,
                  profileRoute === undefined
                    ? profile === "Oracle"
                      ? (options.oracleSelection ?? options.selection)
                      : options.selection
                    : pinnedSelection(profileRoute),
                ).preset
                const policy =
                  profileRoute === undefined
                    ? compactionPolicy(
                        profile === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                        options.compactionSummarySelection,
                      )
                    : pinnedCompactionPolicy(profileRoute, summaryModel)
                return {
                  child_execution_id: makeChildExecutionId(input.parentTurnId, child.childId),
                  address_id: addressId,
                  input: [Content.text(child.prompt)],
                  override: { ...preset, ...(policy === undefined ? {} : { compaction_policy: policy }) },
                  metadata: {
                    product_profile: profile,
                    steering_enabled: true,
                    ...(input.workspace === undefined ? {} : { rika_workspace: input.workspace }),
                    rika_execution_route: durableRoute,
                  },
                }
              }),
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
          const result = yield* client
            .inspectChildFanOut({ fan_out_id: Ids.ChildFanOutId.make(fanOutId) })
            .pipe(Effect.mapError(error))
          return result.fan_out === null ? undefined : mapFanOut(result.fan_out)
        }),
        cancelFanOut: Effect.fn("ExecutionBackend.cancelFanOut")(function* (fanOutId, cancelledAt, reason) {
          const result = yield* client
            .cancelChildFanOut({
              fan_out_id: Ids.ChildFanOutId.make(fanOutId),
              cancelled_at: cancelledAt,
              ...(reason === undefined ? {} : { reason }),
            })
            .pipe(Effect.mapError(error))
          return mapFanOut(result.fan_out)
        }),
        registerWorkflows: Effect.fn("ExecutionBackend.registerWorkflows")(function* () {
          return yield* Effect.forEach(definitions, (definition) => client.registerWorkflowDefinition(definition), {
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
        startWorkflow: Effect.fn("ExecutionBackend.startWorkflow")(function* (name, runId, revision, ownerTurnId) {
          const result = yield* client
            .startWorkflowRun({
              execution_id: workflowExecutionId(runId, ownerTurnId),
              workflow_definition_id: idFor(name),
              ...(revision === undefined ? {} : { revision }),
            })
            .pipe(Effect.mapError(error))
          return workflow(result)
        }),
        inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (runId, ownerTurnId) {
          const result = yield* client
            .inspectWorkflowRun(workflowExecutionId(runId, ownerTurnId))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (runId, ownerTurnId) {
          const result = yield* client
            .cancelWorkflowRun(workflowExecutionId(runId, ownerTurnId))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (input) {
          yield* client
            .spawnChildRun({
              execution_id: executionId(input.parentTurnId),
              child_execution_id: makeChildExecutionId(input.parentTurnId, input.childId),
              address_id: addressId,
              preset_name: input.profile,
              input: [Content.text(input.prompt)],
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
              const metadata = { steering_enabled: true, multi_agent_enabled: true }
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
              const oracleCompaction =
                options.modelVariantPolicy === "fixed-selection"
                  ? compactionPolicy(options.oracleCompaction ?? options.compaction, options.compactionSummarySelection)
                  : pinnedCompactionPolicy(input.executionRoute.oracle, input.executionRoute.compactionSummary)
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
                      Task: pinnedSelection(agentRoutes.task),
                    }
              yield* Effect.logInfo("execution.starting").pipe(
                Effect.annotateLogs({
                  "rika.model.name": selection.model,
                  "rika.model.provider": selection.provider,
                }),
              )
              const registered = yield* client.registerAgent({
                id: agentId,
                address: addressId,
                agent: Agent.make(`rika-${encodeURIComponent(input.turnId)}`, {
                  model: selection,
                  toolkit: toolkitFor(options),
                }),
                permissions: [...parentPermissions, childRunSpawnPermission],
                ...(options.permissionPolicy === undefined ? {} : { permission_rules: options.permissionPolicy }),
                metadata,
                ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
                handoff_targets: subagentHandoffTargets,
                child_run_presets: Object.fromEntries(
                  Object.entries(presets(selection, oracleSelection, agentModels)).map(([name, preset]) => {
                    const agentRoute =
                      name === "Librarian"
                        ? agentRoutes?.librarian
                        : name === "Painter"
                          ? agentRoutes?.painter
                          : name === "Review"
                            ? agentRoutes?.review
                            : name === "ReadThread"
                              ? agentRoutes?.readThread
                              : name === "Task"
                                ? agentRoutes?.task
                                : undefined
                    const policy =
                      name === "Oracle"
                        ? oracleCompaction
                        : agentRoute === undefined
                          ? rootCompaction
                          : pinnedCompactionPolicy(agentRoute, input.executionRoute.compactionSummary)
                    return [name, { ...preset, ...(policy === undefined ? {} : { compaction_policy: policy }) }]
                  }),
                ),
              })
              const id = executionId(input.turnId)
              const start = client
                .startExecutionByAgentDefinition({
                  root_address_id: addressId,
                  session_id: sessionId(input.threadId),
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
                    client.getExecution(id).pipe(
                      Effect.matchEffect({
                        onFailure: () => Effect.fail(startError),
                        onSuccess: (existing) => (existing === undefined ? Effect.fail(startError) : Effect.void),
                      }),
                    ),
                  ),
                )
              const starter = yield* Effect.forkChild(start)
              yield* Effect.yieldNow
              const awaitAccepted: Effect.Effect<void, Client.ClientError> = Effect.suspend(() =>
                client
                  .getExecution(id)
                  .pipe(
                    Effect.flatMap((existing) =>
                      existing === undefined
                        ? Effect.sleep("25 millis").pipe(Effect.andThen(awaitAccepted))
                        : Effect.void,
                    ),
                  ),
              )
              const started = starter.pollUnsafe()
              if (started !== undefined) yield* Fiber.join(starter)
              else
                yield* Effect.raceFirst(awaitAccepted, Fiber.join(starter)).pipe(
                  Effect.timeoutOrElse({
                    duration: "15 seconds",
                    orElse: () => Effect.fail(Client.ClientError.make({ message: "Execution acceptance timed out" })),
                  }),
                )
              yield* Clock.currentTimeMillis.pipe(
                Effect.flatMap((acceptedAt) =>
                  Effect.logInfo("execution.accepted").pipe(
                    Effect.annotateLogs("rika.duration.ms", acceptedAt - startedAt),
                  ),
                ),
              )
              return yield* followExecution(client, input.turnId, undefined, input.onEvent).pipe(
                Effect.ensuring(Fiber.interrupt(starter)),
              )
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
          function* (turnId, afterCursor, onEvent) {
            return yield* followExecution(client, turnId, afterCursor, onEvent).pipe(Effect.mapError(error))
          },
          (effect) => traceWithoutResult("ExecutionBackend.follow", effect),
        ),
        replay: Effect.fn("ExecutionBackend.replay")(function* (turnId, afterCursor) {
          return yield* client
            .replayExecution({
              execution_id: executionId(turnId),
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
        pageEvents: Effect.fn("ExecutionBackend.pageEvents")(function* (turnId, direction, cursor, limit) {
          return yield* client
            .pageExecutionEvents({
              execution_id: executionId(turnId),
              direction,
              ...(cursor === undefined
                ? {}
                : direction === "forward"
                  ? { after_cursor: cursor }
                  : { before_cursor: cursor }),
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
        cancel: Effect.fn("ExecutionBackend.cancel")(function* (turnId, cancelledAt) {
          return yield* Effect.gen(function* () {
            const accepted = yield* client.cancelExecution({
              execution_id: executionId(turnId),
              cancelled_at: cancelledAt,
            })
            const replay = yield* client.replayExecution({ execution_id: executionId(turnId) })
            const events = replay.events.map(event)
            return { turnId, status: Status.make(accepted.status), events }
          }).pipe(Effect.mapError(error))
        }),
        inspect: Effect.fn("ExecutionBackend.inspect")(function* (turnId) {
          const existing = yield* client.getExecution(executionId(turnId))
          if (existing === undefined) return undefined
          return yield* client.inspectExecution(executionId(turnId)).pipe(
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
        steer: Effect.fn("ExecutionBackend.steer")(function* (turnId, text, createdAt) {
          yield* client
            .steer({
              execution_id: executionId(turnId),
              kind: "steering",
              content: [Content.text(text)],
              created_at: createdAt,
            })
            .pipe(Effect.mapError(error))
        }),
        listApprovals: Effect.fn("ExecutionBackend.listApprovals")(function* (turnId) {
          return yield* Effect.gen(function* () {
            const ids = yield* executionTreeIds(client, executionId(turnId))
            const approvals = yield* Effect.forEach(ids, (execution) =>
              client.listPendingApprovals({ execution_id: execution }),
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
            yield* client
              .resolveToolApproval({
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
            yield* client
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
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sqliteModule = yield* Effect.tryPromise({
        try: () => import("@relayfx/sdk/sqlite"),
        catch: error,
      })
      const promoterRegistry = yield* ThreadHost.makeRegistry
      const promoterRegistryLayer = Layer.succeed(ThreadHost.Registry, promoterRegistry)
      {
        const {
          ChildFanOutRuntime,
          LanguageModelService,
          SchemaRegistry,
          SQLite,
          ToolRuntime,
          WorkflowDefinitionRuntime,
        } = sqliteModule
        {
          const toolkit = toolkitFor(options)
          const runnerToolkit = Toolkit.make(...Object.values(toolkit.tools), ThreadHost.promoteTurnTool)
          const handlerLayer = Layer.merge(
            options.additionalHandlerLayer === undefined
              ? RikaToolRuntime.handlerLayer
              : Layer.merge(RikaToolRuntime.handlerLayer, options.additionalHandlerLayer),
            ThreadHost.handlerLayer(promoterRegistry),
          )
          const languageModelLayer = LanguageModelService.layerFromRegistrationEffects([
            ...registrationsFor(options).map((registration) => Effect.succeed(registration)),
            ThreadHost.hostRegistration,
          ])
          const languageModelService =
            LanguageModelService.Service === undefined
              ? undefined
              : Context.get(yield* Layer.build(languageModelLayer), LanguageModelService.Service)
          const namespacedLanguageModelService =
            languageModelService === undefined
              ? undefined
              : LanguageModelService.Service.of({
                  ...languageModelService,
                  provide: (selection, effect) =>
                    languageModelService.provide(
                      selection,
                      withNamespacedLanguageModel(
                        `${selection.provider}:${selection.model}:${selection.registration_key ?? "default"}`,
                        effect,
                      ),
                    ),
                  provideForAgent: (agent, effect) =>
                    languageModelService.provideForAgent(agent, withNamespacedLanguageModel(agent.name, effect)),
                })
          const sharedLanguageModelLayer =
            namespacedLanguageModelService === undefined
              ? languageModelLayer
              : Layer.succeed(LanguageModelService.Service, namespacedLanguageModelService)
          const modelRegistry = Context.get(
            yield* Layer.build(ModelRegistry.layer(registrationsFor(options))),
            ModelRegistry.Service,
          )
          const sharedModelRegistryLayer = Layer.succeed(ModelRegistry.Service, modelRegistry)
          const schemaRegistryLayer = SchemaRegistry.layer(outputSchemaRegistrations)
          const rikaToolRuntimeLayer =
            options.toolRuntimeLayerForWorkspace !== undefined && options.resolveWorkspace !== undefined
              ? routedToolRuntimeLayer(options.toolRuntimeLayerForWorkspace, (durableExecutionId) =>
                  turnIdFromExecutionId(durableExecutionId) === undefined && belongsToWorkflow(durableExecutionId)
                    ? Effect.succeed(options.workspace)
                    : options.resolveWorkspace!(durableExecutionId),
                )
              : (options.toolRuntimeLayer ?? RikaToolRuntime.layer(options.workspace))
          const toolRuntimeLayer = ToolRuntime.layerFromToolkit(runnerToolkit, (tool) => ({
            needsApproval:
              tool.name === ThreadHost.promoteTurnTool.name
                ? false
                : (options.toolNeedsApproval?.(tool.name) ?? ToolCatalog.get(tool.name)?.permission === "ask"),
          })).pipe(
            Layer.provide(handlerLayer),
            Layer.provideMerge(
              rikaToolRuntimeLayer.pipe(
                Layer.provide(MediaAnalyzer.layer(options.selection)),
                Layer.provide(sharedModelRegistryLayer),
                Layer.provide(
                  Layer.mergeAll(
                    ParallelSearch.layer(remoteToolOptions(options.parallelApiKey)),
                    ReadWebPage.layer(remoteToolOptions(options.parallelApiKey)),
                  ).pipe(Layer.provide(FetchHttpClient.layer)),
                ),
              ),
            ),
          )
          const handlerClientLayer = Layer.fresh(Client.layerFromRuntime)
          const childResult = (client: Client.Interface, childId: string) => {
            const childExecutionId = Ids.ExecutionId.make(childId)
            return client.streamExecution({ execution_id: childExecutionId }).pipe(
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
                return {
                  status:
                    terminal?.type === "execution.completed"
                      ? ("completed" as const)
                      : terminal?.type === "execution.cancelled"
                        ? ("cancelled" as const)
                        : ("failed" as const),
                  output:
                    terminal?.content === undefined || terminal.content.length === 0
                      ? (modelOutput?.content ?? [])
                      : terminal.content,
                }
              }),
            )
          }
          const fanOutHandlers: Layer.Layer<
            ChildFanOutRuntimeModule.HandlerService,
            never,
            Client.RuntimeRequirements
          > = Layer.effect(
            ChildFanOutRuntime.HandlerService,
            Client.Service.pipe(
              Effect.map((client) =>
                ChildFanOutRuntime.HandlerService.of({
                  execute: (child: any, fanOutState: any, idempotencyKey: string) =>
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
                      }
                      const childSelection =
                        override.model === undefined
                          ? options.selection
                          : {
                              provider: override.model.provider,
                              model: override.model.model,
                              ...(override.model.registration_key === undefined &&
                              override.model.registrationKey === undefined
                                ? {}
                                : {
                                    registrationKey: override.model.registration_key ?? override.model.registrationKey,
                                  }),
                            }
                      const childAgentId = fanOutAgentId(fanOutState.fan_out_id, child.child_execution_id)
                      const registered = yield* client.registerAgent({
                        id: childAgentId,
                        address: child.address_id,
                        agent: Agent.make(`rika-fan-out-${String(child.child_execution_id)}`, {
                          ...(override.instructions === undefined ? {} : { instructions: override.instructions }),
                          model: childSelection,
                          toolkit: childToolkit,
                        }),
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
                      yield* client.startExecutionByAgentDefinition({
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
                  cancel: (childExecutionId: any) =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((cancelledAt) =>
                        client.cancelExecution({
                          execution_id: Ids.ExecutionId.make(String(childExecutionId)),
                          cancelled_at: cancelledAt,
                        }),
                      ),
                      Effect.asVoid,
                    ),
                }),
              ),
            ),
          ).pipe(Layer.provide(handlerClientLayer))
          const workflowHandlers: Layer.Layer<
            WorkflowDefinitionRuntimeModule.HandlerService,
            never,
            Client.RuntimeRequirements | ChildFanOutRuntimeModule.Service
          > = Layer.effect(
            WorkflowDefinitionRuntime.HandlerService,
            Effect.gen(function* () {
              const client = yield* Client.Service
              const childFanOut = yield* ChildFanOutRuntime.Service
              return WorkflowDefinitionRuntime.HandlerService.of({
                child: (parentId: any, operation: any, context: any) => {
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
                  const childToolkit = Toolkit.make(
                    ...Object.values(toolkit.tools).filter((tool) => preset.tool_names.includes(tool.name)),
                  )
                  const childAgentId = Ids.AgentId.make(
                    `agent:rika:workflow:${encodeURIComponent(parentExecutionId)}:${String(operation.id)}`,
                  )
                  const policy = compactionPolicy(
                    profileName === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                    options.compactionSummarySelection,
                  )
                  return Effect.gen(function* () {
                    const startedAt = yield* Clock.currentTimeMillis
                    const encodedInput = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(operation.input ?? {})
                    const registered = yield* client.registerAgent({
                      id: childAgentId,
                      address: grounded ? operation.address_id : addressId,
                      agent: Agent.make(`rika-workflow-${String(childId)}`, {
                        instructions: preset.instructions,
                        model: childSelection,
                        toolkit: childToolkit,
                      }),
                      permissions: preset.permissions.map((name) => ({ name, value: true })),
                      ...(options.permissionPolicy === undefined ? {} : { permission_rules: options.permissionPolicy }),
                      output_schema_ref: preset.output_schema_ref,
                      metadata: { ...preset.metadata, steering_enabled: true },
                      ...(policy === undefined ? {} : { compaction_policy: policy }),
                    })
                    yield* client
                      .startExecutionByAgentDefinition({
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
                          client
                            .getExecution(Ids.ExecutionId.make(String(childId)))
                            .pipe(
                              Effect.flatMap((existing) =>
                                existing === undefined ? Effect.fail(startError) : Effect.succeed(existing),
                              ),
                            ),
                        ),
                      )
                    return (yield* childResult(client, String(childId))).output
                  }).pipe(
                    Effect.mapError((cause) =>
                      WorkflowDefinitionRuntime.WorkflowRuntimeError.make({ message: String(cause) }),
                    ),
                  )
                },
                approval: (_parentId: any, operation: any) =>
                  Effect.succeed({ approved: true, prompt: operation.prompt }),
                timer: (_parentId: any, operation: any) => Effect.sleep(`${operation.duration_ms} millis`),
                branch: () => Effect.succeed(true),
                structuredCompletion: (_schema: any, value: any) => Effect.succeed(value ?? null),
                createChildFanOut: (definition: any) =>
                  childFanOut
                    .create(definition)
                    .pipe(
                      Effect.mapError((cause) =>
                        WorkflowDefinitionRuntime.WorkflowRuntimeError.make({ message: String(cause) }),
                      ),
                    ),
                admitChildFanOut: () => Effect.void,
                inspectChildFanOut: (fanOutId) =>
                  childFanOut
                    .inspect(fanOutId)
                    .pipe(
                      Effect.mapError((cause) =>
                        WorkflowDefinitionRuntime.WorkflowRuntimeError.make({ message: String(cause) }),
                      ),
                    ),
              })
            }),
          ).pipe(Layer.provide(handlerClientLayer))
          const runtimeLayer = closeRelayClientRequirements(
            Runtime.layerEmbedded({
              databaseLayer: SQLite.runtimeDatabaseLayer({ filename: options.filename }),
              languageModelLayer: sharedLanguageModelLayer,
              toolRuntimeLayer,
              schemaRegistryLayer,
              childFanOutHandlersLayer: fanOutHandlers,
              workflowDefinitionHandlersLayer: workflowHandlers,
            }),
          )
          return layerFromClient({
            ...options,
            registerModels: (registrations) =>
              Effect.forEach(
                registrations,
                (registration) =>
                  Effect.all([
                    languageModelService === undefined ? Effect.void : languageModelService.register({ registration }),
                    modelRegistry.register({ registration }),
                  ]).pipe(Effect.asVoid),
                { discard: true },
              ),
          }).pipe(Layer.provide(runtimeLayer), Layer.provide(promoterRegistryLayer))
        }
      }
    }),
  )
