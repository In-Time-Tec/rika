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
import {
  Client,
  Content,
  ArtifactStore,
  Ids,
  ModelHub,
  PromptAssembler,
  Runtime,
  ToolRuntime as RelayToolRuntime,
} from "@relayfx/sdk"
import { Cause, Context, Crypto, Deferred, Duration, Effect, Encoding, Layer, PlatformError, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelRegistry } from "@batonfx/core"
import { BackendError } from "@rika/product/execution-service"
import { AgentProfile } from "@rika/product/execution-child-run"
import * as DataBlobStore from "../../data-blob-store"
import * as ContextTokenizer from "../../context-tokenizer"
import * as MediaAnalyzerRuntime from "../../model/provider/media-analysis-adapter"
import * as SubagentJoin from "./relay-child-result"
import * as ThreadHost from "./host/relay-thread-host"
import { makeFanOutHost, childResult } from "./host/relay-fan-out-host"
import { makeWorkflowHost } from "./host/relay-workflow-host"
import { childExecutionDepth, delegationAvailableAtDepth } from "../../agent-depth"
import { Service as ExecutionService } from "@rika/product/execution-service"
import type { Service as ExecutionServiceType } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./relay-execution-adapter"
import * as Adapter from "./relay-execution-adapter"
import * as Identifier from "./relay-execution-identifier"
import * as Mapping from "./relay-event-mapping"
import * as Recovery from "./relay-execution-recovery"
import * as ChildResult from "./relay-child-result"
import * as ModelRouting from "../../model/routing/relay-model-registry"
import * as ToolAdapter from "./relay-tool-runtime"
import { parentPermissions, resolve } from "../../agent/definition/baton-agent-definition"
import { createHash } from "node:crypto"
const addressId = Ids.AddressId.make("address:rika")
const fanOutAgentId = Adapter.fanOutAgentId
const toolExecutionPolicy = ToolAdapter.toolExecutionPolicy
type Service = ExecutionServiceType
const Service = ExecutionService
export { AgentProfile } from "@rika/product/execution-child-run"
export type { AgentProfile as AgentProfileType } from "@rika/product/execution-child-run"
export { BackendError, Service } from "@rika/product/execution-service"
export { Event } from "@rika/product/execution-event"
export { executionReference } from "@rika/product/execution-identifier"
export { Status } from "@rika/product/execution-status"
export type { ExecutionCheckpoint, Result, EventPage } from "@rika/product/execution-event"
export type {
  ExecutionReference,
  InvocationSource,
  OpenRootExecution,
  TurnPromoter,
} from "@rika/product/execution-identifier"
export type { EventScope, PromptPart, SessionPurpose, StartInput } from "@rika/product/execution-request"
export type {
  ChildEvent,
  ChildProjection,
  FanOutInput,
  FanOutInspection,
  InvokeChildInput,
  JoinPolicy,
} from "@rika/product/execution-child-run"
export type { PendingApproval } from "@rika/product/execution-approval"
export type { Inspection } from "@rika/product/execution-inspection"
export type { ExecutionExtensionPin, WorkflowInspection } from "@rika/product/execution-workflow"
export type { Interface } from "@rika/product/execution-service"
export { layerFromClient, buildChildRunInput } from "./relay-execution-adapter"
export type {
  LayerOptions,
  ModelVariantPolicy,
  ToolRuntimeRequirements,
  ExternalToolRuntimeRequirements,
} from "./relay-execution-adapter"
export {
  lazyModelRegistryLayer,
  defaultModelResilience,
  modelVariantKey,
  toolkitFor,
  webSearchFactories,
} from "../../model/routing/relay-model-registry"
export { turnIdFromExecutionId, workspaceFromExecutionId } from "./relay-execution-identifier"
export { eventHistoryOption } from "../../model/routing/relay-model-registry"
export * as ContextCompaction from "../../context-compaction"
export * as StreamingOnlyModel from "../../streaming-only-model"
export * as PromptCache from "../../prompt-cache"
export * as WorkflowDefinitions from "../relay-workflow-compiler"
export type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"

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
        catch: Mapping.error,
      })
      const promoterRegistry = yield* ThreadHost.makeRegistry
      const promoterRegistryLayer = Layer.succeed(ThreadHost.Registry, promoterRegistry)
      const relayClient = yield* Deferred.make<Client.Interface>()
      const recoveryScope = yield* Effect.scope
      const recoveryChildSettlementGrace = Duration.fromInputUnsafe(
        options.recoveryChildSettlementGrace ?? Recovery.defaultRecoveryChildSettlementGrace,
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
                  Effect.retry({ schedule: Recovery.recoveryRetrySchedule }),
                  Effect.orDie,
                )
                const unsafe = Recovery.hasLiveSubagentWork(inspection)
                yield* Effect.logInfo("execution.context.baseline.assembled").pipe(
                  Effect.annotateLogs({
                    "rika.context.baseline.hash": hash,
                    "rika.execution.id": execution,
                    "rika.recovery.quarantined": unsafe,
                  }),
                )
                if (unsafe) {
                  yield* Recovery.reconcileUnsafeRecovery({
                    client,
                    execution,
                    childSettlementGrace: recoveryChildSettlementGrace,
                  }).pipe(Effect.forkIn(recoveryScope))
                  return yield* Effect.never
                }
                return assembled
              }),
          })
          const toolkit = ModelRouting.toolkitFor(options)
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
            const routePin = yield* Adapter.pinnedRouteForExecution({ client, execution: parent }).pipe(
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
            const threadId = Identifier.threadIdFromMetadata(parent.metadata)
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
            const childRoute = ModelRouting.routeForProfile({ pin: routePin, profile })
            const childPreset = resolve(profile, ModelRouting.pinnedSelection(childRoute)).preset
            const durableRoute = yield* Schema.decodeUnknownEffect(Schema.Json)(routePin).pipe(
              Effect.mapError((cause) =>
                AgentErrors.AgentContract.AgentToolError.make({ tool: toolName, message: String(cause) }),
              ),
            )
            const children = calls.map((childCall) => ({
              child_execution_id: Identifier.makeChildExecutionId({
                parentTurnId: invocation.executionId,
                childId: childCall.callId,
              }),
              address_id: addressId,
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
                      child.child_execution_id ===
                      Identifier.makeChildExecutionId({
                        parentTurnId: invocation.executionId,
                        childId: currentCall.callId,
                      }),
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
          const initialRegistrations = [...Adapter.registrationsFor(options), yield* ThreadHost.hostRegistration]
          const relayModelContext = yield* Layer.build(
            Layer.unwrap(
              Layer.build(ModelRouting.lazyModelRegistryLayer(initialRegistrations)).pipe(
                Effect.map((context) => ModelHub.testLayer(Context.get(context, ModelRegistry.ModelRegistry))),
              ),
            ),
          ).pipe(Effect.mapError(Mapping.error))
          const modelRegistry = Context.get(relayModelContext, ModelHub.Service).modelRegistry
          const languageModelLayer = Layer.mergeAll(Layer.succeedContext(relayModelContext), ContextTokenizer.layer)
          const sharedModelRegistryLayer = Layer.succeed(ModelRegistry.ModelRegistry, modelRegistry)
          const rikaToolRuntimeLayer =
            options.toolRuntimeLayerForWorkspace !== undefined && options.resolveWorkspace !== undefined
              ? ToolAdapter.routedToolRuntimeLayer({
                  layerForWorkspace: options.toolRuntimeLayerForWorkspace,
                  resolveWorkspace: options.resolveWorkspace,
                })
              : (options.toolRuntimeLayer ??
                RikaToolRuntime.layer(options.workspace).pipe(
                  Layer.catchCause((cause) =>
                    Layer.effectContext(Effect.fail(BackendError.make({ message: Cause.pretty(cause) }))),
                  ),
                ))
          const credentials = options.webSearchCredentials ?? {}
          const search = ModelRouting.webSearchFactories(credentials)
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
                Effect.flatMap((client) => ChildResult.awaitChildResult({ client, childId: childExecutionId })),
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
          const fanOutHandlers = makeFanOutHost({
            relayClient,
            toolkit,
            options,
            fanOutAgentId,
            addressId,
            parentPermissions,
            toolExecutionPolicy,
          })
          const workflowHandlers = makeWorkflowHost({
            options,
            relayClient,
            addressId,
            toolExecutionPolicy,
            childResult,
          })
          const runtimeLayer = Runtime.layerEmbedded({
            database: SQLite.database({
              filename: options.filename,
              ...ModelRouting.eventHistoryOption(options.filename),
            }),
            languageModelLayer,
            toolRuntimeLayer,
            blobStoreLayer: DataBlobStore.layer,
            promptAssemblerLayer,
            childFanOutHostLayer: fanOutHandlers,
            workflowDefinitionHostLayer: workflowHandlers,
          })
          return Adapter.layerFromClient({
            ...options,
            onClientReady: (client) => Deferred.complete(relayClient, Effect.succeed(client)).pipe(Effect.asVoid),
            attemptCost: Adapter.zeroPriceFromMetadata(options.registration.metadata),
            registerModels: (registrations) =>
              Effect.forEach(
                registrations,
                (registration) =>
                  modelRegistry.register({
                    registration: ModelRouting.withResilience({ registration, resilience: options.modelResilience }),
                  }),
                { discard: true },
              ),
          }).pipe(Layer.provide(runtimeLayer), Layer.provide(promoterRegistryLayer))
        }
      }
    }),
  )
