import { Cause, Clock, Duration, Effect, Fiber, Function, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { Tool } from "effect/unstable/ai"
import { Client, Ids } from "@relayfx/sdk"
import { ModelRegistry, ModelResilience } from "@batonfx/core"
import type { Compaction } from "@batonfx/core"
import { Redacted } from "effect"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { MediaAnalyzer } from "@rika/coding-tools/media-view-service"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { AgentProfile } from "@rika/product/execution-child-run"
import { BackendError, Service } from "@rika/product/execution-service"
import type { Execution, Resident } from "@relayfx/sdk"
import * as ThreadHost from "./host/relay-thread-host"
import * as ExecutionIdentifier from "./relay-execution-identifier"
import * as ExecutionMapping from "./relay-event-mapping"
import { failureKind } from "./relay-execution-tree"
import * as Follow from "./relay-execution-follow"
import * as ModelRouting from "../../model/routing/relay-model-registry"
import * as ToolRuntime from "./relay-tool-runtime"
import { childExecutionMethods } from "./relay-child-execution-methods"
import { controlMethods } from "./relay-execution-control-methods"
import { childExecutionDepth, toolsAtDepth } from "../../agent-depth"
import { mainInstructions, presets, rootPermissions } from "../../agent/definition/baton-agent-definition"
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
  readonly additionalToolkit?: import("effect/unstable/ai").Toolkit.Toolkit<AdditionalTools>
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

export type ChildRunInputBase = Pick<Execution.SpawnChildRunInput, "child_execution_id" | "address_id" | "input">
type ChildRunDefinition =
  | { readonly _tag: "preset"; readonly presetName: AgentProfile }
  | {
      readonly _tag: "override"
      readonly definition: Pick<
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
    }
export const buildChildRunInput: {
  (definition: ChildRunDefinition): (base: ChildRunInputBase) => ChildRunInputBase & Record<string, unknown>
  (base: ChildRunInputBase, definition: ChildRunDefinition): ChildRunInputBase & Record<string, unknown>
} = Function.dual(2, (base: ChildRunInputBase, definition: ChildRunDefinition) =>
  definition._tag === "preset"
    ? { ...base, preset_name: definition.presetName }
    : { ...base, ...definition.definition },
)

const addressId = Ids.AddressId.make("address:rika")
const agentId = Ids.AgentId.make("agent:rika")
const rootAgentName = "rika"
export const fanOutAgentId = (input: { readonly fanOutId: string; readonly childExecutionId: string }) =>
  Ids.AgentId.make(`agent:rika:fan-out:${input.fanOutId}:${input.childExecutionId}`)
export const registrationsFor = <AdditionalTools extends Record<string, Tool.Any>, R>(
  options: LayerOptions<AdditionalTools, R>,
) => [
  ModelRouting.withResilience({ registration: options.registration, resilience: options.modelResilience }),
  ...(options.additionalRegistrations ?? []).map((registration) =>
    ModelRouting.withResilience({ registration, resilience: options.modelResilience }),
  ),
]
export const zeroPriceFromMetadata = (metadata: ModelRegistry.Metadata | undefined) =>
  metadata?.pricing !== undefined &&
  typeof metadata.pricing === "object" &&
  metadata.pricing !== null &&
  (metadata.pricing as { inputPerMTok?: unknown }).inputPerMTok === 0 &&
  (metadata.pricing as { outputPerMTok?: unknown }).outputPerMTok === 0
    ? { amount: 0, currency: "USD" }
    : undefined
export const pinnedRouteForExecution = (input: {
  readonly client: Client.Interface
  readonly execution: Execution.Execution
}) =>
  Effect.gen(function* () {
    let current: Execution.Execution | undefined = input.execution
    for (let depth = 0; depth < 3 && current !== undefined; depth += 1) {
      const route = ExecutionIdentifier.decodeExecutionRouteMetadata(current.metadata)
      if (route !== undefined) return route
      const parentId: unknown = current.metadata?.parent_execution_id
      current =
        typeof parentId === "string" ? yield* input.client.executions.get(Ids.ExecutionId.make(parentId)) : undefined
    }
    return undefined
  })

export const layerFromClient = <AdditionalTools extends Record<string, Tool.Any> = {}>(
  options: Pick<
    LayerOptions<AdditionalTools>,
    | "selection"
    | "oracleSelection"
    | "compactionSummarySelection"
    | "additionalToolkit"
    | "compaction"
    | "oracleCompaction"
    | "defaultReasoningEffort"
    | "modelVariantPolicy"
  > & {
    readonly workspace?: string
    readonly resolveWorkspace?: LayerOptions["resolveWorkspace"]
    readonly webSearchCredentials?: LayerOptions["webSearchCredentials"]
    readonly registerModels?: (registrations: ReadonlyArray<ModelRegistry.Registration>) => Effect.Effect<void>
    readonly onClientReady?: (client: Client.Interface) => Effect.Effect<void>
    readonly attemptCost?: { readonly amount: number; readonly currency: string } | undefined
  },
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = yield* Client.Service
      if (options.onClientReady !== undefined) yield* options.onClientReady(client)
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
        wakeThreadHost: ThreadHost.wakeThreadHost({
          client,
          addressId,
          hostGate,
          hostInstance,
          awaitParkedHost,
          failureKind,
        }),
        registerTurnPromoter: (promoter) => registry.register(promoter),
        ...childExecutionMethods({
          client,
          options,
          context: { addressId, childExecutionDepth, toolsAtDepth },
        }),
        start: Effect.fn(
          function* (input) {
            return yield* Effect.gen(function* () {
              const startedAt = yield* Clock.currentTimeMillis
              const id = ExecutionIdentifier.executionId({ turnId: input.turnId, reference: undefined })
              const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(input.executionRoute)
              const metadata = {
                steering_enabled: true,
                rika_execution_id: String(id),
                rika_thread_id: input.threadId,
                rika_agent_depth: 0,
                rika_reasoning_effort: input.reasoningEffort ?? input.executionRoute.main.effort,
                rika_execution_route: durableRoute,
              }
              const rootCompaction =
                options.modelVariantPolicy === "fixed-selection"
                  ? ModelRouting.compactionPolicy({
                      compaction: options.compaction,
                      summaryModel: options.compactionSummarySelection,
                    })
                  : ModelRouting.pinnedCompactionPolicy({
                      route: input.executionRoute.main,
                      summaryModel: input.executionRoute.compactionSummary,
                    })
              const selection =
                options.modelVariantPolicy === "fixed-selection"
                  ? ModelRouting.variantSelection({
                      selection: options.selection,
                      effort: input.reasoningEffort ?? options.defaultReasoningEffort,
                      fast: input.fastMode === true,
                      policy: options.modelVariantPolicy ?? "registration-key",
                    })
                  : ModelRouting.pinnedSelection(input.executionRoute.main)
              const oracleSelection =
                options.modelVariantPolicy === "fixed-selection"
                  ? options.oracleSelection
                  : ModelRouting.pinnedSelection(input.executionRoute.oracle)
              const childRunPresets = Object.fromEntries(
                [1, 2].flatMap((childDepth) =>
                  Object.entries(
                    presets({
                      model: selection,
                      oracleModel: oracleSelection,
                      ...(options.modelVariantPolicy === "fixed-selection"
                        ? {}
                        : { agentModels: ModelRouting.agentSelections(input.executionRoute) }),
                    }),
                  ).map(([name, preset]) => {
                    const profile = name as AgentProfile
                    const mainRoute = ModelRouting.usesMainRoute(profile)
                    const profileRoute = ModelRouting.routeForProfile({ pin: input.executionRoute, profile })
                    const effort = mainRoute
                      ? (input.reasoningEffort ?? input.executionRoute.main.effort)
                      : profileRoute.effort
                    const policy =
                      options.modelVariantPolicy === "fixed-selection"
                        ? ModelRouting.compactionPolicy({
                            compaction: mainRoute
                              ? options.compaction
                              : (options.oracleCompaction ?? options.compaction),
                            summaryModel: options.compactionSummarySelection,
                          })
                        : ModelRouting.pinnedCompactionPolicy({
                            route: profileRoute,
                            summaryModel: input.executionRoute.compactionSummary,
                          })
                    return [
                      `${name}:${childDepth}`,
                      {
                        ...preset,
                        model: {
                          ...preset.model,
                          metadata: {
                            rika_execution_route: durableRoute,
                            rika_thread_id: input.threadId,
                            rika_agent_depth: childDepth,
                            rika_reasoning_effort: effort,
                          },
                        },
                        tool_names: ModelRouting.availableTools({
                          options,
                          names: toolsAtDepth(preset.tool_names, childDepth),
                        }),
                        ...(policy === undefined ? {} : { compaction_policy: policy }),
                        metadata: {
                          ...preset.metadata,
                          steering_enabled: true,
                          rika_thread_id: input.threadId,
                          rika_agent_depth: childDepth,
                          rika_reasoning_effort: effort,
                          rika_execution_route: durableRoute,
                        },
                      },
                    ]
                  }),
                ),
              )
              yield* Effect.logInfo("execution.starting").pipe(
                Effect.annotateLogs({
                  "rika.model.name": selection.model,
                  "rika.model.provider": selection.provider,
                }),
              )
              const agentName = rootAgentName
              const rootTools = Object.values(ModelRouting.toolkitFor(options).tools).filter(
                (tool) => tool.name !== "search_threads" && tool.name !== "read_thread_transcript",
              )
              const registered = yield* client.agents.register({
                id: agentId,
                address: addressId,
                name: agentName,
                instructions: mainInstructions,
                model: ModelRouting.relayModelSelection(selection),
                tools: rootTools.map((tool) => ({ name: tool.name })),
                tool_execution: ToolRuntime.toolExecutionPolicy,
                permissions: rootPermissions,
                permission_rules: ToolRuntime.allowAllPermissionRules,
                metadata,
                ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
                child_run_presets: childRunPresets,
              })
              const startInput = {
                root_address_id: addressId,
                session_id: ExecutionIdentifier.startSessionId(input),
                agent_id: agentId,
                agent_revision: registered.record.current_revision,
                input: ExecutionMapping.executionInput(input),
                idempotency_key: input.turnId,
                execution_id: id,
                metadata,
              } as const
              const start = client.executions.startByAgentDefinition(startInput).pipe(
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
                  ExecutionIdentifier.awaitExecutionAvailable({ client, id }),
                  Fiber.join(starter),
                )
              yield* Clock.currentTimeMillis.pipe(
                Effect.flatMap((acceptedAt) =>
                  Effect.logInfo("execution.accepted").pipe(
                    Effect.annotateLogs("rika.duration.ms", acceptedAt - startedAt),
                  ),
                ),
              )
              return yield* Follow.followExecution({
                client,
                turnId: input.turnId,
                afterCursor: undefined,
                onEvent: input.onEvent,
                stopAtActionableWait: true,
                reference: undefined,
                eventScope: input.eventScope ?? "tree",
                attemptCost: options.attemptCost,
              }).pipe(Effect.ensuring(Fiber.interrupt(starter)))
            }).pipe(
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("execution.start.failed").pipe(
                      Effect.annotateLogs("rika.failure.kind", failureKind(cause)),
                    ),
              ),
              Effect.annotateLogs({
                "rika.execution.id": String(
                  ExecutionIdentifier.executionId({ turnId: input.turnId, reference: undefined }),
                ),
                "rika.thread.id": String(input.threadId),
                "rika.turn.id": String(input.turnId),
              }),
              Effect.mapError(ExecutionMapping.error),
            )
          },
          (effect) => ExecutionMapping.traceWithoutResult({ name: "ExecutionBackend.start", effect }),
        ),
        follow: Effect.fn(
          function* (turnId, afterCursor, onEvent, reference, eventScope) {
            return yield* Follow.followExecution({
              client,
              turnId,
              afterCursor,
              onEvent,
              stopAtActionableWait: true,
              reference,
              eventScope: eventScope ?? "tree",
              attemptCost: options.attemptCost,
            }).pipe(Effect.mapError(ExecutionMapping.error))
          },
          (effect) => ExecutionMapping.traceWithoutResult({ name: "ExecutionBackend.follow", effect }),
        ),
        ...controlMethods(client),
      })
    }),
  )
