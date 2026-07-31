import * as Backend from "./execution-backend"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import * as AgentSelection from "@rika/coding-tools/agent-tool-contract"
import * as AgentToolkits from "@rika/coding-tools/agent-tool-contract"
import * as AgentTools from "@rika/coding-tools/agent-tool-contract"
import * as AgentErrors from "@rika/coding-tools/agent-tool-contract"
import { Catalog as ToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { ChildFanOutHost, Client, Content, ArtifactStore, Ids, ModelHub, PromptAssembler, Runtime, ToolRuntime as RelayToolRuntime, WorkflowDefinitionHost } from "@relayfx/sdk"
import { Cause, Clock, Context, Crypto, Deferred, Duration, Effect, Encoding, Layer, PlatformError, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ModelRegistry } from "@batonfx/core"
import { BackendError } from "@rika/product/execution-service"
import type { Execution } from "@relayfx/sdk"
import { AgentProfile } from "@rika/product/execution-child-run"
import { ExecutionId } from "@rika/product/execution-identifier"
import * as DataBlobStore from "../../data-blob-store"
import * as ContextTokenizer from "../../context-tokenizer"
import * as MediaAnalyzerRuntime from "../../model/provider/media-analysis-adapter"
import * as SubagentJoin from "./subagent-join"
import * as ThreadHost from "./thread-host"
import { definitions } from "../relay-workflow-compiler"
import { childExecutionDepth, delegationAvailableAtDepth } from "../../agent-depth"
import { Service as ExecutionService } from "@rika/product/execution-service"
import type { Service as ExecutionServiceType } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./execution-backend"
import { createHash } from "node:crypto"
const toolExecutionPolicy = { concurrency: "unbounded" as const }
const dependencies = new Proxy({} as typeof Backend.RelayInternals, { get: (_, key) => Backend.RelayInternals[key as keyof typeof Backend.RelayInternals] })
type Service = ExecutionServiceType
const Service = ExecutionService
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
        catch: dependencies.error,
      })
      const promoterRegistry = yield* ThreadHost.makeRegistry
      const promoterRegistryLayer = Layer.succeed(ThreadHost.Registry, promoterRegistry)
      const relayClient = yield* Deferred.make<Client.Interface>()
      const recoveryScope = yield* Effect.scope
      const recoveryChildSettlementGrace = Duration.fromInputUnsafe(
        options.recoveryChildSettlementGrace ?? dependencies.defaultRecoveryChildSettlementGrace,
      )
      if (!Duration.isFinite(recoveryChildSettlementGrace) || Duration.toMillis(recoveryChildSettlementGrace) < 0)
        return yield* BackendError.make({ message: "Recovery child settlement grace must be finite and non-negative" })
      {
        const { SQLite } = sqliteModule
        {
          const defaultPromptAssembler = Context.get(
            yield* Layer.build(
              PromptAssembler.defaultLayerWithStores.pipe(
                Layer.provide(Layer.merge(DataBlobStore.layer, ArtifactStore.passthroughLayer)),
              ),
            ),
            PromptAssembler.Service,
          )
          const promptAssemblerLayer = PromptAssembler.layer({
            assemble: (input) =>
              Effect.gen(function* () {
                const assembled = yield* defaultPromptAssembler.assemble(input)
                const metadata = input.agent.metadata
                const execution = metadata?.rika_execution_id
                if (metadata?.rika_agent_depth !== 0 || typeof execution !== "string") return assembled
                const hash = createHash("sha256").update(assembled.system).digest("hex")
                const client = yield* Deferred.await(relayClient)
                const inspection = yield* client.executions.inspect(Ids.ExecutionId.make(execution)).pipe(
                  Effect.tapError(() =>
                    Effect.logWarning("execution.recovery.classification.retrying").pipe(
                      Effect.annotateLogs({ "rika.execution.id": execution }),
                    ),
                  ),
                  Effect.retry({ schedule: dependencies.recoveryRetrySchedule }),
                  Effect.orDie,
                )
                const unsafe = dependencies.hasLiveSubagentWork(inspection)
                yield* Effect.logInfo("execution.context.baseline.assembled").pipe(
                  Effect.annotateLogs({
                    "rika.context.baseline.hash": hash,
                    "rika.execution.id": execution,
                    "rika.recovery.quarantined": unsafe,
                  }),
                )
                if (unsafe) {
                  yield* dependencies.reconcileUnsafeRecovery(client, execution, recoveryChildSettlementGrace).pipe(
                    Effect.forkIn(recoveryScope),
                  )
                  return yield* Effect.never
                }
                return assembled
              }),
          })
          const toolkit = dependencies.toolkitFor(options)
          const runnerToolkit = Toolkit.make(
            ...Object.values(toolkit.tools).filter(
              (tool) => tool.name !== AgentSelection.AgentContract.awaitSubagentsToolName,
            ),
            ThreadHost.promoteTurnTool,
          )
          const delegation = Effect.fn("ExecutionBackend.delegateAgent")(function* (
            toolName: AgentSelection.DelegationToolName,
            profile: AgentProfile,
            input: AgentTools.TaskInput | AgentTools.ReadThreadInput,
          ) {
            const invocation = yield* ToolInvocation.ToolInvocation
            const parentExecutionId = Ids.ExecutionId.make(invocation.executionId)
            const parentDepth = childExecutionDepth(invocation.executionId)
            if (!delegationAvailableAtDepth(toolName, parentDepth)) {
              return yield* AgentErrors.AgentContract.AgentToolError.make({
                tool: toolName,
                message:
                  toolName === "task"
                    ? "Task subagents cannot start other Task subagents; complete the workspace work directly or use one focused specialist"
                    : `Agent delegation is unavailable at depth ${parentDepth}`,
              })
            }
            const client = yield* Deferred.await(relayClient)
            const parent = yield* client.executions
              .get(parentExecutionId)
              .pipe(
                Effect.mapError((cause) =>
                  AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
                ),
              )
            if (parent === undefined) {
              return yield* AgentErrors.AgentContract.AgentToolError.make({
                tool: toolName,
                message: `Execution ${invocation.executionId} was not found`,
              })
            }
            const routePin = yield* dependencies.pinnedRouteForExecution(client, parent).pipe(
              Effect.mapError((cause) =>
                AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
              ),
            )
            if (routePin === undefined) {
              return yield* AgentErrors.AgentContract.AgentToolError.make({
                tool: toolName,
                message: "The parent execution does not have a pinned model route",
              })
            }
            const threadId = dependencies.threadIdFromMetadata(parent.metadata)
            const requestedPrompt =
              "threadId" in input && input.threadId !== undefined
                ? `Requested thread ID: ${input.threadId}\n\n${input.prompt}`
                : input.prompt
            const calls = [
              {
                callId: invocation.callId,
                prompt:
                  profile === "ReadThread" && threadId !== undefined
                    ? `Current thread ID: ${threadId}\n\n${requestedPrompt}`
                    : requestedPrompt,
              },
            ]
            const childDepth = parentDepth + 1
            const childRoute = dependencies.routeForProfile(routePin, profile)
            const childPreset = dependencies.resolve(profile, dependencies.pinnedSelection(childRoute)).preset
            const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(
              Effect.mapError((cause) =>
                AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
              ),
            )
            const children = calls.map((childCall) => ({
              child_execution_id: dependencies.makeChildExecutionId(invocation.executionId, childCall.callId),
              address_id: dependencies.addressId,
              input: [Content.text(childCall.prompt)],
              preset_name: `${profile}:${childDepth}`,
              metadata: {
                product_profile: profile,
                steering_enabled: true,
                rika_agent_depth: childDepth,
                rika_permissions: [...childPreset.permissions],
                rika_reasoning_effort: childRoute.effort,
                ...(threadId === undefined ? {} : { rika_thread_id: threadId }),
                rika_execution_route: durableRoute,
              },
            }))
            yield* Effect.forEach(
              children,
              (child) =>
                client.childRuns.spawn({
                  execution_id: parentExecutionId,
                  ...child,
                  wait: true,
                }),
              { discard: true },
            ).pipe(
              Effect.mapError((cause) =>
                AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
              ),
            )
            const currentCall = calls.find((childCall) => childCall.callId === invocation.callId)
            const current =
              currentCall === undefined
                ? undefined
                : children.find(
                    (child) =>
                      child.child_execution_id === dependencies.makeChildExecutionId(invocation.executionId, currentCall.callId),
                  )
            if (current === undefined) {
              return yield* AgentErrors.AgentContract.AgentToolError.make({
                tool: toolName,
                message: `The child for tool call ${invocation.callId} is not in its fan-out batch`,
              })
            }
            yield* Effect.logInfo("delegation.spawned").pipe(
              Effect.annotateLogs({
                "rika.execution.id": invocation.executionId,
                "rika.child.execution.id": String(current.child_execution_id),
                "rika.tool.name": toolName,
              }),
            )
            return AgentTools.AgentContract.spawned({ childExecutionId: String(current.child_execution_id) })
          })
          const delegationHandlerLayer = AgentToolkits.AgentContract.modelToolkit.toLayer({
            task: (input) => delegation("task", "Task", input),
            oracle: (input) => delegation("oracle", "Oracle", input),
            librarian: (input) => delegation("librarian", "Librarian", input),
            review: (input) => delegation("review", "Review", input),
            surgeon: (input) => delegation("surgeon", "Surgeon", input),
            read_thread: (input) => delegation("read_thread", "ReadThread", input),
          })
          const handlerLayer = Layer.mergeAll(
            options.additionalHandlerLayer === undefined
              ? ToolCatalog.handlerLayer
              : Layer.merge(ToolCatalog.handlerLayer, options.additionalHandlerLayer),
            ThreadHost.handlerLayer(promoterRegistry),
            delegationHandlerLayer,
          )
          const initialRegistrations = [...dependencies.registrationsFor(options), yield* ThreadHost.hostRegistration]
          const relayModelContext = yield* Layer.build(
            Layer.unwrap(
              Layer.build(dependencies.lazyModelRegistryLayer(initialRegistrations)).pipe(
                Effect.map((context) => ModelHub.testLayer(Context.get(context, ModelRegistry.ModelRegistry))),
              ),
            ),
          ).pipe(Effect.mapError(dependencies.error))
          const modelRegistry = Context.get(relayModelContext, ModelHub.Service).modelRegistry
          const languageModelLayer = Layer.mergeAll(Layer.succeedContext(relayModelContext), ContextTokenizer.layer)
          const sharedModelRegistryLayer = Layer.succeed(ModelRegistry.ModelRegistry, modelRegistry)
          const rikaToolRuntimeLayer =
            options.toolRuntimeLayerForWorkspace !== undefined && options.resolveWorkspace !== undefined
              ? dependencies.routedToolRuntimeLayer(options.toolRuntimeLayerForWorkspace, options.resolveWorkspace)
              : (options.toolRuntimeLayer ??
                RikaToolRuntime.layer(options.workspace).pipe(
                  Layer.catchCause((cause) =>
                    Layer.effectContext(Effect.fail(BackendError.make({ message: Cause.pretty(cause) }))),
                  ),
                ))
          const credentials = options.webSearchCredentials ?? {}
          const search = dependencies.webSearchFactories(credentials)
          const readPageCredential = WebSearchProvider.configuredReadPageCredential(credentials)
          if (search.unsupportedIds.length > 0)
            yield* Effect.logWarning("web_search.unsupported_provider").pipe(
              Effect.annotateLogs("rika.web_search.provider_ids", search.unsupportedIds.join(",")),
            )
          const handledToolRuntimeLayer = RelayToolRuntime.layerFromHandledToolkit(runnerToolkit, {
            tools: () => ({ needsApproval: false }),
            invocation: {
              make: (context) =>
                Effect.gen(function* () {
                  const crypto = yield* Crypto.Crypto
                  const idempotencyKeyDigest = yield* crypto
                    .digest("SHA-256", new TextEncoder().encode(context.idempotencyKey))
                    .pipe(
                      Effect.mapError((cause) =>
                        RelayToolRuntime.ToolExecutionFailed.make({
                          tool_name: context.call.name,
                          message: String(cause),
                        }),
                      ),
                    )
                  const invocation = ToolInvocation.ToolInvocation.of({
                    executionId: String(context.executionId),
                    callId: String(context.call.id),
                    toolName: String(context.call.name),
                    eventSequence: Number(context.eventSequence),
                    createdAt: context.createdAt,
                    idempotencyKeyDigest: Encoding.encodeHex(idempotencyKeyDigest),
                  })
                  return Context.make(ToolInvocation.ToolInvocation, invocation)
                }),
            },
          }).pipe(
            Layer.provide(handlerLayer),
            Layer.provide(
              rikaToolRuntimeLayer.pipe(
                Layer.provide(MediaAnalyzerRuntime.layer(options.selection)),
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
          const subagentJoinTool = SubagentJoin.registeredTool({
            childRuns: (execution) =>
              Deferred.await(relayClient).pipe(
                Effect.flatMap((client) => client.executions.inspect(Ids.ExecutionId.make(execution))),
                Effect.map((inspection) =>
                  inspection.child_runs.map((child) => ({
                    childExecutionId: String(child.child_execution_id),
                    status: child.status,
                  })),
                ),
                Effect.mapError(String),
              ),
            resolveChild: (childExecutionId) =>
              Deferred.await(relayClient).pipe(
                Effect.flatMap((client) => dependencies.awaitChildResult(client, childExecutionId)),
                Effect.mapError(String),
              ),
          })
          const toolRuntimeLayer = Layer.effect(
            RelayToolRuntime.HostService,
            Effect.gen(function* () {
              const host = yield* RelayToolRuntime.HostService
              const registered = yield* host.registeredTools
              return RelayToolRuntime.HostService.of({
                registeredTools: Effect.succeed([...registered, subagentJoinTool]),
              })
            }),
          ).pipe(Layer.provide(handledToolRuntimeLayer))
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
                      const childAgentId = dependencies.fanOutAgentId(fanOutState.fan_out_id, child.child_execution_id)
                      const registered = yield* client.agents.register({
                        id: childAgentId,
                        address: child.address_id,
                        name: `rika-fan-out-${String(child.child_execution_id)}`,
                        ...(override.instructions === undefined ? {} : { instructions: override.instructions }),
                        model: dependencies.relayModelSelection(childSelection),
                        tools: Object.values(childToolkit.tools).map((tool) => ({ name: tool.name })),
                        tool_execution: toolExecutionPolicy,
                        permissions:
                          override.permissions === undefined
                            ? dependencies.parentPermissions
                            : override.permissions.map((name: string) => ({ name, value: true })),
                        permission_rules: dependencies.allowAllPermissionRules,
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
                        session_id: dependencies.childSessionId(child.child_execution_id),
                        agent_id: childAgentId,
                        agent_revision: registered.record.current_revision,
                        execution_id: Ids.ExecutionId.make(String(child.child_execution_id)),
                        ...(child.input === undefined ? {} : { input: child.input }),
                        idempotency_key: idempotencyKey,
                        metadata: {
                          child_execution_id: child.child_execution_id,
                          fan_out_id: fanOutState.fan_out_id,
                          rika_permissions:
                            override.permissions === undefined
                              ? dependencies.parentPermissions
                                  .filter((permission) => permission.value === true)
                                  .map((permission) => permission.name)
                              : [...override.permissions],
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
                const childId = dependencies.makeChildExecutionId(parentExecutionId, String(operation.id))
                const grounded = "address_id" in operation
                const profileName = grounded ? String(operation.preset_name) : "Task"
                const availablePresets = dependencies.presets({ model: options.selection, oracleModel: options.oracleSelection })
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
                const policy = dependencies.compactionPolicy(
                  profileName === "Oracle" ? (options.oracleCompaction ?? options.compaction) : options.compaction,
                  options.compactionSummarySelection,
                )
                return Deferred.await(relayClient).pipe(
                  Effect.flatMap((client) =>
                    Effect.gen(function* () {
                      const childToolkit = Toolkit.make(
                        ...Object.values(dependencies.toolkitFor(options).tools).filter((tool) =>
                          preset.tool_names.includes(tool.name),
                        ),
                      )
                      const encodedInput = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
                        operation.input ?? {},
                      )
                      const registered = yield* client.agents.register({
                        id: childAgentId,
                        address: grounded ? operation.address_id : dependencies.addressId,
                        name: `rika-workflow-${String(childId)}`,
                        instructions: preset.instructions,
                        model: dependencies.relayModelSelection(childSelection),
                        tools: Object.values(childToolkit.tools).map((tool) => ({ name: tool.name })),
                        tool_execution: toolExecutionPolicy,
                        permissions: preset.permissions.map((name) => ({ name, value: true })),
                        permission_rules: dependencies.allowAllPermissionRules,
                        metadata: {
                          ...preset.metadata,
                          steering_enabled: true,
                          rika_execution_id: String(childId),
                        },
                        ...(policy === undefined ? {} : { compaction_policy: policy }),
                      })
                      yield* client.executions
                        .startByAgentDefinition({
                          root_address_id: grounded ? operation.address_id : dependencies.addressId,
                          session_id: dependencies.childSessionId(childId),
                          agent_id: childAgentId,
                          agent_revision: registered.record.current_revision,
                          execution_id: Ids.ExecutionId.make(String(childId)),
                          input: [Content.text(encodedInput)],
                          idempotency_key: context.idempotency_key,
                          metadata: {
                            child_execution_id: childId,
                            rika_permissions: [...preset.permissions],
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
            database: SQLite.database({ filename: options.filename, ...dependencies.eventHistoryOption(options.filename) }),
            languageModelLayer,
            toolRuntimeLayer,
            blobStoreLayer: DataBlobStore.layer,
            promptAssemblerLayer,
            childFanOutHostLayer: fanOutHandlers,
            workflowDefinitionHostLayer: workflowHandlers,
          })
          return dependencies.layerFromClient({
            ...options,
            onClientReady: (client) => Deferred.complete(relayClient, Effect.succeed(client)).pipe(Effect.asVoid),
            attemptCost: dependencies.zeroPriceFromMetadata(options.registration.metadata),
            registerModels: (registrations) =>
              Effect.forEach(
                registrations,
                (registration) =>
                  modelRegistry.register({ registration: dependencies.withResilience(registration, options.modelResilience) }),
                { discard: true },
              ),
          }).pipe(Layer.provide(runtimeLayer), Layer.provide(promoterRegistryLayer))
        }
      }
    }),
  )
