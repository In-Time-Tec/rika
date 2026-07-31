import {
  Client,
  ArtifactStore,
  Ids,
  ModelHub,
  PromptAssembler,
  Runtime,
  ToolRuntime as RelayToolRuntime,
} from "@relayfx/sdk"
import { Cause, Context, Crypto, Deferred, Duration, Effect, Encoding, Layer, PlatformError } from "effect"
import { Tool } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelRegistry } from "@batonfx/core"
import { BackendError } from "@rika/product/execution-service"
import * as DataBlobStore from "../../data-blob-store"
import * as ThreadHost from "./host/relay-thread-host"
import { makeFanOutHost, childResult } from "./host/relay-fan-out-host"
import { makeWorkflowHost } from "./host/relay-workflow-host"
import { Service as ExecutionService } from "@rika/product/execution-service"
import type { Service as ExecutionServiceType } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./relay-execution-adapter"
import { fanOutAgentId } from "./relay-execution-input"
import { makeDelegationLayer } from "./relay-execution-delegation-layer"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as MediaAnalyzerRuntime from "../../model/provider/media-analysis-adapter"
import * as ContextTokenizer from "../../context-tokenizer"
import * as SubagentJoin from "./relay-child-result"
import { makePromptAssemblerLayer } from "./relay-execution-prompt-layer"
import { registrationsFor, zeroPriceFromMetadata } from "./relay-execution-routing"
import * as ClientLayer from "./relay-execution-client-layer"
import * as Mapping from "./relay-event-mapping"
import * as Recovery from "./relay-execution-recovery"
import * as ChildResult from "./relay-child-result"
import * as ModelRouting from "../../model/routing/relay-model-registry"
import * as ToolAdapter from "./relay-tool-runtime"
import { toolExecutionPolicy } from "./relay-tool-runtime"
import { parentPermissions } from "../../agent/definition/baton-agent-definition"
const addressId = Ids.AddressId.make("address:rika")
type Service = ExecutionServiceType
const Service = ExecutionService
export const makeRelayLayer = <
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
          const promptAssemblerLayer = makePromptAssemblerLayer({
            relayClient,
            recoveryScope,
            childSettlementGrace: recoveryChildSettlementGrace,
            defaultPromptAssembler,
          })
          const delegationLayers = makeDelegationLayer({
            relayClient,
            options,
            promoterRegistry,
            addressId,
          })
          const { toolkit, runnerToolkit, handlerLayer } = delegationLayers
          const initialRegistrations = [...registrationsFor(options), yield* ThreadHost.hostRegistration]
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
          return ClientLayer.layerFromClient({
            ...options,
            onClientReady: (client) => Deferred.complete(relayClient, Effect.succeed(client)).pipe(Effect.asVoid),
            attemptCost: zeroPriceFromMetadata(options.registration.metadata),
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
