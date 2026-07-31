import * as Backend from "./execution-backend"
import * as AgentSelection from "@rika/coding-tools/agent-tool-contract"
import * as AgentToolkits from "@rika/coding-tools/agent-tool-contract"
import * as AgentAwait from "@rika/coding-tools/agent-tool-contract"
import * as AgentTools from "@rika/coding-tools/agent-tool-contract"
import * as AgentErrors from "@rika/coding-tools/agent-tool-contract"
import { MediaAnalyzer } from "@rika/coding-tools/media-view-service"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import { Client, Content, Ids, ToolRuntime as RelayToolRuntime } from "@relayfx/sdk"
import { Cause, Clock, Duration, Effect, Fiber, Layer, Option, Schedule, Schema, Semaphore } from "effect"
import { Tool } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ModelRegistry, type Permissions } from "@batonfx/core"
import { AgentProfile } from "@rika/product/execution-child-run"
import { BackendError, Service } from "@rika/product/execution-service"
import type { Execution, Resident } from "@relayfx/sdk"
import type { OpenRootExecution } from "@rika/product/execution-identifier"
import type { EventScope } from "@rika/product/execution-request"
import type { ExecutionCheckpoint } from "@rika/product/execution-event"
import { Status } from "@rika/product/execution-status"
import * as DataBlobStore from "../../data-blob-store"
import * as ContextTokenizer from "../../context-tokenizer"
import * as MediaAnalyzerRuntime from "../../model/provider/media-analysis-adapter"
import * as SubagentJoin from "./subagent-join"
import * as ThreadHost from "./thread-host"
import { presets, mainInstructions, rootPermissions, names as agentProfileNames } from "../../agent/definition/baton-agent-definition"
import { childExecutionDepth, toolsAtDepth } from "../../agent-depth"
import type { LayerOptions } from "./execution-backend"
import { ExecutionIdentifiers } from "./execution-identifiers"
import { definitions, idFor } from "../relay-workflow-compiler"
const turnIdFromExecutionId = ExecutionIdentifiers.turnIdFromExecutionId
const dependencies = new Proxy({} as typeof Backend.RelayInternals, { get: (_, key) => Backend.RelayInternals[key as keyof typeof Backend.RelayInternals] })
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
                  from: dependencies.addressId,
                  to: instance.address_id,
                  content: [Content.text(notification)],
                  idempotency_key: `rika:queue-wake:${wake.threadId}:${wake.generation}`,
                })
              }),
            )
            .pipe(
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("thread_host.notification.failed").pipe(
                      Effect.annotateLogs({
                        "rika.thread.id": wake.threadId,
                        "rika.queue.wake_generation": wake.generation,
                        "rika.queue.revision": wake.queueRevision,
                        "rika.failure.kind": dependencies.failureKind(cause),
                      }),
                    ),
              ),
              Effect.mapError(dependencies.error),
            )
        }),
        registerTurnPromoter: (promoter) => registry.register(promoter),
        createFanOut: Effect.fn("ExecutionBackend.createFanOut")((input) =>
          Effect.gen(function* () {
            const routePin = input.executionRoute
            const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin)
            const summaryModel = routePin?.compactionSummary
            const parentExecutionId = dependencies.executionId(input.parentTurnId)
            const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(dependencies.error))
            const threadId = dependencies.threadIdFromMetadata(parent?.metadata)
            const depth = childExecutionDepth(String(parentExecutionId)) + 1
            const children = yield* Effect.forEach(input.children, (child) => {
              const profile = child.profile ?? "Task"
              const profileRoute = dependencies.routeForProfile(routePin, profile)
              const mainRoute = dependencies.usesMainRoute(profile)
              let selected = dependencies.pinnedSelection(profileRoute)
              if (options.modelVariantPolicy === "fixed-selection")
                selected = mainRoute ? options.selection : (options.oracleSelection ?? options.selection)
              const preset = dependencies.resolve(profile, selected).preset
              const policy =
                options.modelVariantPolicy === "fixed-selection"
                  ? dependencies.compactionPolicy(
                      mainRoute ? options.compaction : (options.oracleCompaction ?? options.compaction),
                      options.compactionSummarySelection,
                    )
                  : dependencies.pinnedCompactionPolicy(profileRoute, summaryModel)
              const effort = profileRoute.effort
              return Effect.succeed({
                child_execution_id: dependencies.makeChildExecutionId(input.parentTurnId, child.childId),
                address_id: dependencies.addressId,
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
                  tool_names: dependencies.availableTools(options, toolsAtDepth(preset.tool_names, depth)),
                  ...(policy === undefined ? {} : { compaction_policy: policy }),
                },
                metadata: {
                  product_profile: profile,
                  steering_enabled: true,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: effort,
                  ...(input.workspace === undefined ? {} : { rika_workspace: input.workspace }),
                  ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
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
            return dependencies.mapFanOut(state)
          }).pipe(Effect.mapError(dependencies.error)),
        ),
        inspectFanOut: Effect.fn("ExecutionBackend.inspectFanOut")(function* (fanOutId) {
          const result = yield* client.childRuns
            .inspectFanOut({ fan_out_id: Ids.ChildFanOutId.make(fanOutId) })
            .pipe(Effect.mapError(dependencies.error))
          return result.fan_out === null ? undefined : dependencies.mapFanOut(result.fan_out)
        }),
        cancelFanOut: Effect.fn("ExecutionBackend.cancelFanOut")(function* (fanOutId, cancelledAt, reason) {
          const result = yield* client.childRuns
            .cancelFanOut({
              fan_out_id: Ids.ChildFanOutId.make(fanOutId),
              cancelled_at: cancelledAt,
              ...(reason === undefined ? {} : { reason }),
            })
            .pipe(Effect.mapError(dependencies.error))
          return dependencies.mapFanOut(result.fan_out)
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
            Effect.mapError(dependencies.error),
          )
        }),
        startWorkflow: Effect.fn("ExecutionBackend.startWorkflow")(
          function* (name, runId, revision, ownerTurnId, workspace) {
            const result = yield* client.workflows
              .startRun({
                execution_id: dependencies.workflowExecutionId(runId, ownerTurnId, workspace),
                workflow_definition_id: idFor(name),
                ...(revision === undefined ? {} : { revision }),
              })
              .pipe(Effect.mapError(dependencies.error))
            return dependencies.workflow(result)
          },
        ),
        inspectWorkflow: Effect.fn("ExecutionBackend.inspectWorkflow")(function* (runId, ownerTurnId, workspace) {
          const result = yield* client.workflows
            .inspectRun(dependencies.workflowExecutionId(runId, ownerTurnId, workspace))
            .pipe(Effect.mapError(dependencies.error))
          return result === undefined ? undefined : dependencies.workflow(result)
        }),
        cancelWorkflow: Effect.fn("ExecutionBackend.cancelWorkflow")(function* (runId, ownerTurnId, workspace) {
          const result = yield* client.workflows
            .cancelRun(dependencies.workflowExecutionId(runId, ownerTurnId, workspace))
            .pipe(Effect.mapError(dependencies.error))
          return result === undefined ? undefined : dependencies.workflow(result)
        }),
        invokeChild: Effect.fn("ExecutionBackend.invokeChild")(function* (input) {
          const parentExecutionId = dependencies.executionId(input.parentTurnId)
          const parent = yield* client.executions.get(parentExecutionId).pipe(Effect.mapError(dependencies.error))
          const routePin = parent === undefined ? undefined : dependencies.executionRouteFromMetadata(parent.metadata)
          if (parent === undefined || routePin === undefined)
            return yield* BackendError.make({ message: `Execution ${input.parentTurnId} has no pinned model route` })
          const route = input.profile === "Title" ? routePin.title : dependencies.routeForProfile(routePin, input.profile)
          if (route === undefined)
            return yield* BackendError.make({ message: `Execution ${input.parentTurnId} has no pinned title route` })
          const preset =
            input.profile === "Title"
              ? dependencies.resolveTitle(dependencies.pinnedSelection(route))
              : dependencies.resolve(input.profile, dependencies.pinnedSelection(route)).preset
          const depth = childExecutionDepth(String(parentExecutionId)) + 1
          const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(Effect.mapError(dependencies.error))
          const threadId = dependencies.threadIdFromMetadata(parent.metadata)
          yield* client.childRuns
            .spawn({
              execution_id: parentExecutionId,
              child_execution_id: dependencies.makeChildExecutionId(input.parentTurnId, input.childId),
              address_id: dependencies.addressId,
              input: [Content.text(input.prompt)],
              instructions: preset.instructions,
              model: {
                ...preset.model,
                metadata: {
                  rika_execution_route: durableRoute,
                  rika_agent_depth: depth,
                  rika_reasoning_effort: route.effort,
                  ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
                },
              },
              tool_names:
                input.profile === "Title" ? [] : dependencies.availableTools(options, toolsAtDepth(preset.tool_names, depth)),
              permissions: preset.permissions,
              ...(input.profile === "Title"
                ? {}
                : { compaction_policy: dependencies.pinnedCompactionPolicy(route, routePin.compactionSummary) }),
              metadata: {
                product_profile: input.profile,
                steering_enabled: true,
                rika_agent_depth: depth,
                rika_permissions: [...preset.permissions],
                rika_reasoning_effort: route.effort,
                ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
                rika_execution_route: durableRoute,
              },
              wait: false,
            })
            .pipe(Effect.mapError(dependencies.error))
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
              const id = dependencies.executionId(input.turnId)
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
                  ? dependencies.compactionPolicy(options.compaction, options.compactionSummarySelection)
                  : dependencies.pinnedCompactionPolicy(input.executionRoute.main, input.executionRoute.compactionSummary)
              const selection =
                options.modelVariantPolicy === "fixed-selection"
                  ? dependencies.variantSelection(
                      options.selection,
                      input.reasoningEffort ?? options.defaultReasoningEffort,
                      input.fastMode === true,
                      options.modelVariantPolicy ?? "registration-key",
                    )
                  : dependencies.pinnedSelection(input.executionRoute.main)
              const oracleSelection =
                options.modelVariantPolicy === "fixed-selection"
                  ? options.oracleSelection
                  : dependencies.pinnedSelection(input.executionRoute.oracle)
              const childRunPresets = Object.fromEntries(
                [1, 2].flatMap((childDepth) =>
                  Object.entries(
                    presets({
                      model: selection,
                      oracleModel: oracleSelection,
                      ...(options.modelVariantPolicy === "fixed-selection"
                        ? {}
                        : { agentModels: dependencies.agentSelections(input.executionRoute) }),
                    }),
                  ).map(([name, preset]) => {
                    const profile = name as AgentProfile
                    const mainRoute = dependencies.usesMainRoute(profile)
                    const profileRoute = dependencies.routeForProfile(input.executionRoute, profile)
                    const effort = mainRoute
                      ? (input.reasoningEffort ?? input.executionRoute.main.effort)
                      : profileRoute.effort
                    const policy =
                      options.modelVariantPolicy === "fixed-selection"
                        ? dependencies.compactionPolicy(
                            mainRoute ? options.compaction : (options.oracleCompaction ?? options.compaction),
                            options.compactionSummarySelection,
                          )
                        : dependencies.pinnedCompactionPolicy(profileRoute, input.executionRoute.compactionSummary)
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
                        tool_names: dependencies.availableTools(options, toolsAtDepth(preset.tool_names, childDepth)),
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
              const agentName = dependencies.rootAgentName
              const rootTools = Object.values(dependencies.toolkitFor(options).tools).filter(
                (tool) => tool.name !== "search_threads" && tool.name !== "read_thread_transcript",
              )
              const registered = yield* client.agents.register({
                id: dependencies.agentId,
                address: dependencies.addressId,
                name: agentName,
                instructions: mainInstructions,
                model: dependencies.relayModelSelection(selection),
                tools: rootTools.map((tool) => ({ name: tool.name })),
                tool_execution: dependencies.toolExecutionPolicy,
                permissions: rootPermissions,
                permission_rules: dependencies.allowAllPermissionRules,
                metadata,
                ...(rootCompaction === undefined ? {} : { compaction_policy: rootCompaction }),
                child_run_presets: childRunPresets,
              })
              const startInput = {
                root_address_id: dependencies.addressId,
                session_id: dependencies.startSessionId(input),
                agent_id: dependencies.agentId,
                agent_revision: registered.record.current_revision,
                input: dependencies.executionInput(input),
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
              else yield* Effect.raceFirst(dependencies.awaitExecutionAvailable(client, id), Fiber.join(starter))
              yield* Clock.currentTimeMillis.pipe(
                Effect.flatMap((acceptedAt) =>
                  Effect.logInfo("execution.accepted").pipe(
                    Effect.annotateLogs("rika.duration.ms", acceptedAt - startedAt),
                  ),
                ),
              )
              return yield* dependencies.followExecution(
                client,
                input.turnId,
                undefined,
                input.onEvent,
                true,
                undefined,
                input.eventScope,
                options.attemptCost,
              ).pipe(Effect.ensuring(Fiber.interrupt(starter)))
            }).pipe(
              Effect.tapCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("execution.start.failed").pipe(
                      Effect.annotateLogs("rika.failure.kind", dependencies.failureKind(cause)),
                    ),
              ),
              Effect.annotateLogs({
                "rika.execution.id": String(dependencies.executionId(input.turnId)),
                "rika.thread.id": String(input.threadId),
                "rika.turn.id": String(input.turnId),
              }),
              Effect.mapError(dependencies.error),
            )
          },
          (effect) => dependencies.traceWithoutResult("ExecutionBackend.start", effect),
        ),
        follow: Effect.fn(
          function* (turnId, afterCursor, onEvent, reference, eventScope) {
            return yield* dependencies.followExecution(
              client,
              turnId,
              afterCursor,
              onEvent,
              true,
              reference,
              eventScope,
              options.attemptCost,
            ).pipe(Effect.mapError(dependencies.error))
          },
          (effect) => dependencies.traceWithoutResult("ExecutionBackend.follow", effect),
        ),
        replay: Effect.fn("ExecutionBackend.replay")(function* (turnId, afterCursor, reference) {
          const id = dependencies.executionId(turnId, reference)
          const cursor = dependencies.cursorOf(afterCursor)
          return yield* client.executions
            .replay({
              execution_id: id,
              ...(cursor === undefined ? {} : { after_cursor: cursor }),
            })
            .pipe(
              Effect.flatMap((result) =>
                dependencies.checkpointForExecution(client, id).pipe(Effect.map((checkpoint) => ({ result, checkpoint }))),
              ),
              Effect.map(({ result, checkpoint }) => {
                const events = result.events.map(dependencies.event)
                return {
                  turnId,
                  status: dependencies.statusFromEvents(events),
                  events,
                  ...(checkpoint === undefined ? {} : { checkpoint }),
                }
              }),
              Effect.mapError(dependencies.error),
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
              execution_id: dependencies.executionId(turnId, reference),
              direction,
              ...cursorPage,
              ...(limit === undefined ? {} : { limit }),
            })
            .pipe(
              Effect.map((result) => ({
                events: result.events.map(dependencies.event),
                hasMore: result.has_more,
                ...(result.oldest_cursor === undefined ? {} : { oldestCursor: result.oldest_cursor }),
                ...(result.newest_cursor === undefined ? {} : { newestCursor: result.newest_cursor }),
              })),
              Effect.mapError(dependencies.error),
            )
        }),
        listOpenRootExecutions: Effect.gen(function* () {
          const roots: Array<OpenRootExecution> = []
          let cursor: string | undefined
          do {
            const page = yield* client.executions
              .list({
                statuses: ["queued", "running", "waiting"],
                limit: 200,
                ...(cursor === undefined ? {} : { cursor }),
              })
              .pipe(Effect.mapError(dependencies.error))
            for (const record of page.records) {
              const turnId = turnIdFromExecutionId(String(record.execution_id))
              if (turnId === undefined) continue
              roots.push({
                executionId: String(record.execution_id),
                turnId,
                createdAt: record.created_at,
              })
            }
            cursor = page.next_cursor
          } while (cursor !== undefined)
          return roots
        }).pipe(Effect.withSpan("ExecutionBackend.listOpenRootExecutions")),
        cancel: Effect.fn("ExecutionBackend.cancel")(function* (turnId, reference) {
          return yield* Effect.gen(function* () {
            const id = dependencies.executionId(turnId, reference)
            yield* dependencies.awaitExecutionAvailable(client, id).pipe(
              Effect.timeoutOrElse({
                duration: "15 seconds",
                orElse: () =>
                  Effect.fail(
                    Client.ClientError.make({ message: "Execution did not become available for cancellation" }),
                  ),
              }),
            )
            const cancelledAt = yield* Clock.currentTimeMillis
            const accepted = yield* client.executions.cancel({
              execution_id: id,
              cancelled_at: cancelledAt,
            })
            const tree = yield* dependencies.executionTreeIds(client, id)
            yield* dependencies.cancelOutlivingChildren(client, id, cancelledAt, tree)
            const replay = yield* client.executions.replay({ execution_id: id })
            const events = replay.events.map(dependencies.event)
            const checkpoint = yield* dependencies.checkpointForExecution(client, id)
            return {
              turnId,
              status: Status.make(accepted.status),
              events,
              ...(checkpoint === undefined ? {} : { checkpoint }),
            }
          }).pipe(Effect.mapError(dependencies.error))
        }),
        inspect: Effect.fn("ExecutionBackend.inspect")(function* (turnId, reference) {
          const existing = yield* client.executions.get(dependencies.executionId(turnId, reference))
          if (existing === undefined) return undefined
          return yield* client.executions.inspect(dependencies.executionId(turnId, reference)).pipe(
            Effect.map((value) => ({
              turnId,
              status: Status.make(value.status),
              ...(existing.created_at === undefined ? {} : { createdAt: existing.created_at }),
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
        }, Effect.mapError(dependencies.error)),
        resolveInvocationSource: Effect.fn("ExecutionBackend.resolveInvocationSource")(function* (requestedId) {
          return yield* Effect.gen(function* () {
            const visited = new Set<string>()
            const found = yield* client.executions.get(Ids.ExecutionId.make(requestedId))
            if (found === undefined) return yield* BackendError.make({ message: "ExecutionNotFound" })
            const source = found
            let current: Execution.Execution = found
            while (true) {
              const id = String(current.id)
              if (visited.has(id)) return yield* BackendError.make({ message: "Malformed execution ancestry" })
              visited.add(id)
              const parentId: unknown = current.metadata?.parent_execution_id
              if (typeof parentId !== "string") break
              const parent: Execution.Execution | undefined = yield* client.executions.get(
                Ids.ExecutionId.make(parentId),
              )
              if (parent === undefined)
                return yield* BackendError.make({ message: `Missing parent execution ${parentId}` })
              current = parent
            }
            const rootExecution = current.metadata?.rika_execution_id
            const threadId = dependencies.threadIdFromMetadata(current.metadata)
            const depth = source.metadata?.rika_agent_depth
            const profile = source.metadata?.product_profile
            if (
              typeof rootExecution !== "string" ||
              !rootExecution.startsWith("execution:") ||
              threadId === undefined ||
              typeof depth !== "number" ||
              !Number.isInteger(depth) ||
              depth < 0 ||
              (depth > 0 && typeof profile !== "string")
            )
              return yield* BackendError.make({ message: `Malformed invocation provenance for ${requestedId}` })
            const callerProfile: unknown = depth === 0 ? "Root" : profile
            if (!Schema.is(dependencies.InvocationProfile)(callerProfile))
              return yield* BackendError.make({ message: `Malformed invocation profile for ${requestedId}` })
            return {
              rootTurnId: rootExecution.slice("execution:".length),
              threadId,
              callerProfile,
              threadCreationDepth: depth,
            }
          }).pipe(Effect.mapError(dependencies.error))
        }),
        steer: Effect.fn("ExecutionBackend.steer")(function* (turnId, text, idempotencyIdentity, reference) {
          const id = dependencies.executionId(turnId, reference)
          const createdAt = yield* Clock.currentTimeMillis
          yield* dependencies.awaitExecutionRunning(client, id).pipe(
            Effect.timeoutOrElse({
              duration: "15 seconds",
              orElse: () =>
                Effect.fail(Client.ClientError.make({ message: "Execution did not become available for steering" })),
            }),
            Effect.mapError(dependencies.error),
          )
          const accepted = yield* client.executions
            .steer({
              execution_id: id,
              idempotency_key: idempotencyIdentity,
              kind: "steering",
              content: [Content.text(text)],
              created_at: createdAt,
            })
            .pipe(
              Effect.mapError((cause) =>
                cause !== null &&
                typeof cause === "object" &&
                "_tag" in cause &&
                cause._tag === "SteeringIdempotencyConflict"
                  ? BackendError.make({
                      message: "Steering idempotency identity was already used with a different semantic payload",
                    })
                  : dependencies.error(cause),
              ),
            )
          return {
            steeringMessageId: String(accepted.steering_message_id),
            sequence: accepted.sequence,
          }
        }),
        listApprovals: Effect.fn("ExecutionBackend.listApprovals")(function* (turnId, reference) {
          return yield* Effect.gen(function* () {
            const ids = yield* dependencies.executionTreeIds(client, dependencies.executionId(turnId, reference))
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
          }).pipe(Effect.mapError(dependencies.error))
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
              .pipe(Effect.mapError(dependencies.error))
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
              .pipe(Effect.mapError(dependencies.error))
          },
        ),
      })
    }),
  )
