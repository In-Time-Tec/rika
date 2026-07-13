import { Agent, type Compaction, ModelRegistry, ModelResilience, type Permissions } from "@batonfx/core"
import { Catalog as ToolCatalog, ParallelSearch, ReadWebPage, Runtime as RikaToolRuntime } from "@rika/tools"
import { Client, Content, type Entity, type Execution, Ids } from "@relayfx/sdk"
import { Duration, Effect, Layer, Option, Redacted, Schedule, Semaphore, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { BackendError, Event, type PromptPart, Service, Status } from "./execution-contract"
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

export interface CompactionPolicy {
  readonly context_window: number
  readonly reserve_tokens: number
  readonly keep_recent_tokens: number
}

export interface LayerOptions<AdditionalTools extends Record<string, Tool.Any> = {}> {
  readonly filename: string
  readonly workspace: string
  readonly parallelApiKey?: Redacted.Redacted<string>
  readonly registration: ModelRegistry.Registration
  readonly additionalRegistrations?: ReadonlyArray<ModelRegistry.Registration>
  readonly selection: ModelRegistry.ModelSelection
  readonly oracleSelection?: ModelRegistry.ModelSelection
  readonly defaultReasoningEffort?: string
  readonly modelVariantPolicy?: ModelVariantPolicy
  readonly modelResilience?: ModelResilience.Interface
  readonly compaction?: Compaction.DefaultOptions
  readonly oracleCompaction?: Compaction.DefaultOptions
  readonly tokenBudget?: number
  readonly permissionPolicy?: Permissions.Ruleset
  readonly additionalToolkit?: Toolkit.Toolkit<AdditionalTools>
  readonly additionalHandlerLayer?: Layer.Layer<Tool.HandlersFor<AdditionalTools>, unknown, never>
  readonly toolRuntimeLayer?: Layer.Layer<RikaToolRuntime.Service, unknown, never>
  readonly toolNeedsApproval?: (name: string) => boolean
}

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

const registrationFor = <AdditionalTools extends Record<string, Tool.Any>>(
  options: LayerOptions<AdditionalTools>,
): ModelRegistry.Registration => withResilience(options.registration, options.modelResilience)

const registrationsFor = <AdditionalTools extends Record<string, Tool.Any>>(
  options: LayerOptions<AdditionalTools>,
): Array<ModelRegistry.Registration> => [
  registrationFor(options),
  ...(options.additionalRegistrations ?? []).map((registration) =>
    withResilience(registration, options.modelResilience),
  ),
]

const compactionPolicy = (compaction: Compaction.DefaultOptions | undefined): CompactionPolicy | undefined =>
  compaction === undefined ||
  compaction.contextWindow === undefined ||
  compaction.reserveTokens === undefined ||
  compaction.keepRecentTokens === undefined
    ? undefined
    : {
        context_window: compaction.contextWindow,
        reserve_tokens: compaction.reserveTokens,
        keep_recent_tokens: compaction.keepRecentTokens,
      }

const toolkitFor = <AdditionalTools extends Record<string, Tool.Any>>(
  options: Pick<LayerOptions<AdditionalTools>, "additionalToolkit">,
) =>
  options.additionalToolkit === undefined
    ? RikaToolRuntime.toolkit
    : Toolkit.make(...Object.values(RikaToolRuntime.toolkit.tools), ...Object.values(options.additionalToolkit.tools))

export const remoteToolOptions = (parallelApiKey: Redacted.Redacted<string> | undefined) =>
  parallelApiKey === undefined ? {} : { apiKey: parallelApiKey }

export const modelVariantKey = (effort: string, fast: boolean) => `effort:${effort}${fast ? ":fast" : ""}`

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
  Ids.ExecutionId.make(turnId.startsWith("child:") ? turnId : `execution:${turnId}`)
const sessionId = (threadId: string) => Ids.SessionId.make(`session:${threadId}`)
const childSessionId = (childExecutionId: Ids.ChildExecutionId) =>
  Ids.SessionId.make(`session:child:${String(childExecutionId)}`)
const error = (cause: unknown) => new BackendError({ message: String(cause) })
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

const mapFanOut = (value: any) => ({
  fanOutId: String(value.fan_out_id),
  parentTurnId: String(value.parent_execution_id).replace(/^execution:/, ""),
  state: value.state,
  maxConcurrency: value.max_concurrency,
  join: value.join._tag,
  members: value.members.map((member: any) => ({
    childId: String(member.child_execution_id).replace(/^child:/, ""),
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
})

const workflow = (value: any) => ({
  runId: String(value.execution_id).replace(/^workflow:/, ""),
  workflow: String(value.pin.workflow_definition_id)
    .replace(/^rika:/, "")
    .replace(/:v1$/, ""),
  revision: value.pin.workflow_definition_revision,
  digest: value.pin.workflow_definition_digest,
  status: value.status,
  createdAt: value.created_at,
  updatedAt: value.updated_at,
})

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

const followExecution = (
  client: Client.Interface,
  turnId: string,
  afterCursor: string | undefined,
  onEvent: ((item: Event) => void) | undefined,
  stopAtActionableWait = true,
) =>
  Effect.gen(function* () {
    const events: Array<Event> = []
    const seen = new Set<string>()
    let stoppedAtActionableWait = false
    const append = (item: Execution.ExecutionEvent) => {
      const mapped = event(item)
      if (seen.has(mapped.cursor)) return mapped
      seen.add(mapped.cursor)
      events.push(mapped)
      onEvent?.(mapped)
      return mapped
    }
    const shouldStop = (item: Execution.ExecutionEvent) => {
      if (
        item.type === "execution.completed" ||
        item.type === "execution.failed" ||
        item.type === "execution.cancelled"
      ) {
        return Effect.succeed(true)
      }
      if (!stopAtActionableWait || !isActionableWait(event(item))) return Effect.succeed(false)
      const waitId = item.data?.wait_id
      if (typeof waitId !== "string") return Effect.succeed(false)
      return client.inspectExecution(executionId(turnId)).pipe(
        Effect.map((inspection) => {
          const actionable = inspection.waiting_on.some((wait) => wait.wait_id === waitId)
          if (actionable) stoppedAtActionableWait = true
          return actionable
        }),
      )
    }
    const attach = (cursor: string | undefined) =>
      client
        .streamExecution({
          execution_id: executionId(turnId),
          ...(cursor === undefined ? {} : { after_cursor: cursor }),
        })
        .pipe(Stream.takeUntilEffect(shouldStop), Stream.map(append), Stream.runDrain)
    yield* attach(afterCursor).pipe(
      Effect.catchTag("EventLogCursorNotFound", () => attach(undefined)),
      Effect.catchTag("ClientError", (streamError) =>
        Effect.gen(function* () {
          const existing = yield* client.getExecution(executionId(turnId))
          if (
            existing === undefined ||
            (existing.status !== "completed" && existing.status !== "failed" && existing.status !== "cancelled")
          ) {
            return yield* Effect.fail(streamError)
          }
          const replay = yield* client.replayExecution({ execution_id: executionId(turnId) })
          for (const item of replay.events) {
            const mapped = append(item)
            if (
              mapped.type === "execution.completed" ||
              mapped.type === "execution.failed" ||
              mapped.type === "execution.cancelled"
            ) {
              break
            }
          }
          if (
            events.every(
              (item) =>
                item.type !== "execution.completed" &&
                item.type !== "execution.failed" &&
                item.type !== "execution.cancelled",
            )
          ) {
            return yield* Effect.fail(streamError)
          }
        }).pipe(Effect.catch(() => Effect.fail(streamError))),
      ),
    )
    const status = statusFromEvents(events)
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
  })

export const layerFromClient = <AdditionalTools extends Record<string, Tool.Any> = {}>(
  options: Pick<
    LayerOptions<AdditionalTools>,
    | "selection"
    | "oracleSelection"
    | "additionalToolkit"
    | "compaction"
    | "oracleCompaction"
    | "tokenBudget"
    | "permissionPolicy"
    | "defaultReasoningEffort"
    | "modelVariantPolicy"
  >,
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
        return yield* client.getOrCreateEntity({
          kind: ThreadHost.entityKind,
          key: Ids.EntityKey.make(threadId),
          metadata: { rika_thread_id: threadId },
          created_at: now,
        })
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
            return yield* Effect.fail(
              new Client.ClientError({ message: `Thread host for ${threadId} is not parked yet` }),
            )
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
        ensureThreadHost: Effect.fn("ExecutionBackend.ensureThreadHost")(function* (threadId, createdAt) {
          yield* hostInstance(threadId, createdAt).pipe(Effect.mapError(error))
        }),
        notifyThreadHost: Effect.fn("ExecutionBackend.notifyThreadHost")(function* (threadId, turnId, now) {
          yield* hostGate
            .withPermits(1)(
              Effect.gen(function* () {
                const created = yield* hostInstance(threadId, now)
                const instance = yield* awaitParkedHost(threadId, created, now)
                yield* client.send({
                  from: addressId,
                  to: instance.address_id,
                  content: [
                    Content.text(
                      JSON.stringify({
                        kind: "pending-turn",
                        thread_id: threadId,
                        ...(turnId === undefined ? {} : { turn_id: turnId }),
                      }),
                    ),
                  ],
                  idempotency_key: turnId === undefined ? `rika:nudge:${threadId}:${now}` : `rika:turn:${turnId}`,
                })
              }),
            )
            .pipe(Effect.mapError(error))
        }),
        registerTurnPromoter: (promoter) => registry.register(promoter),
        createFanOut: Effect.fn("ExecutionBackend.createFanOut")(function* (input) {
          const state = yield* client
            .createChildFanOut({
              fan_out_id: Ids.ChildFanOutId.make(input.fanOutId),
              parent_execution_id: executionId(input.parentTurnId),
              children: input.children.map((child) => {
                const profile = child.profile ?? "Task"
                const preset = resolve(
                  profile,
                  profile === "Oracle" ? (options.oracleSelection ?? options.selection) : options.selection,
                ).preset
                const policy = compactionPolicy(
                  profile === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                )
                return {
                  child_execution_id: Ids.ChildExecutionId.make(`child:${child.childId}`),
                  address_id: addressId,
                  input: [Content.text(child.prompt)],
                  override: { ...preset, ...(policy === undefined ? {} : { compaction_policy: policy }) },
                  metadata: { product_profile: profile, steering_enabled: true },
                }
              }),
              max_concurrency: input.maxConcurrency,
              join:
                input.join === "quorum"
                  ? { _tag: "quorum", count: input.quorum ?? input.children.length }
                  : { _tag: input.join },
              created_at: input.createdAt,
            })
            .pipe(Effect.mapError(error))
          return mapFanOut(state)
        }),
        inspectFanOut: Effect.fn("ExecutionBackend.inspectFanOut")(function* (fanOutId) {
          const result = yield* client
            .inspectChildFanOut({ fan_out_id: Ids.ChildFanOutId.make(fanOutId) })
            .pipe(Effect.mapError(error))
          return result.fan_out === undefined ? undefined : mapFanOut(result.fan_out)
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
        startWorkflow: Effect.fn("ExecutionBackend.startWorkflow")(function* (name, runId, revision) {
          const result = yield* client
            .startWorkflowRun({
              execution_id: Ids.ExecutionId.make(`workflow:${runId}`),
              workflow_definition_id: idFor(name),
              ...(revision === undefined ? {} : { revision }),
            })
            .pipe(Effect.mapError(error))
          return workflow(result)
        }),
        inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (runId) {
          const result = yield* client
            .inspectWorkflowRun(Ids.ExecutionId.make(`workflow:${runId}`))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (runId) {
          const result = yield* client
            .cancelWorkflowRun(Ids.ExecutionId.make(`workflow:${runId}`))
            .pipe(Effect.mapError(error))
          return result === undefined ? undefined : workflow(result)
        }),
        invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (input) {
          yield* client
            .spawnChildRun({
              execution_id: executionId(input.parentTurnId),
              child_execution_id: Ids.ChildExecutionId.make(`child:${input.childId}`),
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
        start: Effect.fn("ExecutionBackend.start")(function* (input) {
          return yield* Effect.gen(function* () {
            const metadata = { steering_enabled: true, multi_agent_enabled: true }
            const rootCompaction = compactionPolicy(options.compaction)
            const selection = variantSelection(
              options.selection,
              input.reasoningEffort ?? options.defaultReasoningEffort,
              input.fastMode === true,
              options.modelVariantPolicy ?? "registration-key",
            )
            const registered = yield* client.registerAgent({
              id: agentId,
              address: addressId,
              agent: Agent.make("rika", { model: selection, toolkit: toolkitFor(options) }),
              permissions: [...parentPermissions, childRunSpawnPermission],
              ...(options.permissionPolicy === undefined ? {} : { permission_rules: options.permissionPolicy }),
              ...(options.tokenBudget === undefined ? {} : { token_budget: options.tokenBudget }),
              metadata,
              ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
              handoff_targets: subagentHandoffTargets,
              child_run_presets: Object.fromEntries(
                Object.entries(presets(selection, options.oracleSelection)).map(([name, preset]) => {
                  const policy = compactionPolicy(
                    name === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                  )
                  return [name, { ...preset, ...(policy === undefined ? {} : { compaction_policy: policy }) }]
                }),
              ),
            })
            const id = executionId(input.turnId)
            yield* client
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
            return yield* followExecution(client, input.turnId, undefined, input.onEvent)
          }).pipe(Effect.mapError(error))
        }),
        follow: Effect.fn("ExecutionBackend.follow")(function* (turnId, afterCursor, onEvent) {
          return yield* followExecution(client, turnId, afterCursor, onEvent).pipe(Effect.mapError(error))
        }),
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
          const existing = yield* client.getExecution(executionId(turnId)).pipe(Effect.mapError(error))
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
            Effect.mapError(error),
          )
        }),
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
          return yield* client.listPendingApprovals({ execution_id: executionId(turnId) }).pipe(
            Effect.map((result) =>
              result.approvals.map((approval) => ({
                waitId: approval.wait_id,
                callId: approval.tool_call_id,
                toolName: approval.tool_name,
                input: approval.input,
                requestedAt: approval.requested_at,
              })),
            ),
            Effect.mapError(error),
          )
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

export const layer = <AdditionalTools extends Record<string, Tool.Any> = {}>(options: LayerOptions<AdditionalTools>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sqliteModule = yield* Effect.promise(() => import("@relayfx/sdk/sqlite"))
      const promoterRegistry = yield* ThreadHost.makeRegistry
      const promoterRegistryLayer = Layer.succeed(ThreadHost.Registry, promoterRegistry)
      {
        const {
          ChildFanOutRuntime,
          LanguageModelService,
          RunnerRuntime,
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
          const runnerLayer = RunnerRuntime.layerWithServices({
            databaseLayer: SQLite.layer({ filename: options.filename }),
            languageModelLayer: LanguageModelService.layerFromRegistrationEffects([
              ...registrationsFor(options).map((registration) => Effect.succeed(registration)),
              ThreadHost.hostRegistration,
            ]),
            schemaRegistryLayer: SchemaRegistry.layer(outputSchemaRegistrations),
            toolRuntimeLayer: ToolRuntime.layerFromToolkit(runnerToolkit, (tool) => ({
              needsApproval:
                tool.name === ThreadHost.promoteTurnTool.name
                  ? false
                  : (options.toolNeedsApproval?.(tool.name) ?? ToolCatalog.get(tool.name)?.permission === "ask"),
            })).pipe(
              Layer.provide(handlerLayer),
              Layer.provideMerge(
                (options.toolRuntimeLayer ?? RikaToolRuntime.layer(options.workspace)).pipe(
                  Layer.provide(MediaAnalyzer.layer(options.selection)),
                  Layer.provide(ModelRegistry.layer(registrationsFor(options))),
                  Layer.provide(
                    Layer.mergeAll(
                      ParallelSearch.layer(remoteToolOptions(options.parallelApiKey)),
                      ReadWebPage.layer(remoteToolOptions(options.parallelApiKey)),
                    ).pipe(Layer.provide(FetchHttpClient.layer)),
                  ),
                ),
              ),
            ),
          })
          const handlerClientLayer = Layer.fresh(Client.layerFromRuntime).pipe(Layer.provideMerge(runnerLayer))
          const childResult = (client: Client.Interface, childId: string) => {
            const childExecutionId = Ids.ExecutionId.make(childId)
            return client
              .streamExecution({ execution_id: childExecutionId })
              .pipe(
                Stream.takeUntil(
                  (item) =>
                    item.type === "execution.completed" ||
                    item.type === "execution.failed" ||
                    item.type === "execution.cancelled",
                ),
                Stream.runCollect,
              )
              .pipe(
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
          const fanOutHandlers = Layer.effect(
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
                        ...(options.tokenBudget === undefined ? {} : { token_budget: options.tokenBudget }),
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
                    client
                      .cancelExecution({
                        execution_id: Ids.ExecutionId.make(String(childExecutionId)),
                        cancelled_at: Date.now(),
                      })
                      .pipe(Effect.asVoid),
                }),
              ),
            ),
          ).pipe(Layer.provide(handlerClientLayer))
          const fanOutLayer = SQLite.childFanOutLayer({ filename: options.filename }, fanOutHandlers)
          const workflowHandlers = Layer.effect(
            WorkflowDefinitionRuntime.HandlerService,
            Effect.gen(function* () {
              const client = yield* Client.Service
              const childFanOut = yield* ChildFanOutRuntime.Service
              return WorkflowDefinitionRuntime.HandlerService.of({
                child: (parentId: any, operation: any) => {
                  const childId = Ids.ChildExecutionId.make(`child:${parentId}:${operation.id}`)
                  const grounded = "address_id" in operation
                  return client
                    .spawnChildRun({
                      execution_id: parentId,
                      child_execution_id: childId,
                      address_id: grounded ? operation.address_id : addressId,
                      ...(grounded ? { preset_name: operation.preset_name } : {}),
                      input: [Content.text(JSON.stringify(operation.input ?? {}))],
                      wait: false,
                    })
                    .pipe(
                      Effect.andThen(childResult(client, String(childId))),
                      Effect.map((result) => result.output),
                    )
                },
                approval: (_parentId: any, operation: any) =>
                  Effect.succeed({ approved: true, prompt: operation.prompt }),
                timer: (_parentId: any, operation: any) => Effect.sleep(`${operation.duration_ms} millis`),
                branch: () => Effect.succeed(true),
                structuredCompletion: (_schema: any, value: any) => Effect.succeed(value ?? null),
                createChildFanOut: (definition: any) => childFanOut.create(definition),
                admitChildFanOut: () => Effect.void,
                inspectChildFanOut: childFanOut.inspect,
              })
            }),
          ).pipe(Layer.provide(handlerClientLayer), Layer.provide(fanOutLayer))
          const workflowLayer = SQLite.workflowLayer({ filename: options.filename }, workflowHandlers)
          const runtimeLayer = workflowLayer.pipe(Layer.provideMerge(fanOutLayer), Layer.provideMerge(runnerLayer))
          return layerFromClient(options).pipe(
            Layer.provide(Client.layerFromRuntime.pipe(Layer.provideMerge(runtimeLayer))),
            Layer.provide(promoterRegistryLayer),
          )
        }
      }
    }),
  )
