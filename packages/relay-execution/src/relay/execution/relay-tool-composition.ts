import { Client, Ids, ToolRuntime as RelayToolRuntime } from "@relayfx/sdk"
import { Context, Crypto, Deferred, Effect, Encoding, Layer } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelRegistry } from "@batonfx/core"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as ToolInvocation from "@rika/coding-tools/tool-invocation"
import * as WebSearchProvider from "@rika/coding-tools/web-search-provider"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as MediaAnalyzerRuntime from "../../model/provider/media-analysis-adapter"
import * as SubagentJoin from "./relay-child-result"
import * as ChildResult from "./relay-child-result"
import type { LayerOptions, ToolRuntimeRequirements } from "./relay-execution-layer"

type RikaToolRuntimeLayer<RuntimeRequirements> = Layer.Layer<
  import("@rika/coding-tools/coding-tool-runtime").Service,
  import("@rika/product/execution-service").BackendError,
  ToolRuntimeRequirements | RuntimeRequirements
>

export const makeToolComposition = <
  AdditionalTools extends Record<string, Tool.Any>,
  RuntimeRequirements,
  RunnerTools extends Record<string, Tool.Any>,
  HandlerRequirements,
  HandlerServices,
>(input: {
  readonly relayClient: Deferred.Deferred<Client.Interface>
  readonly options: LayerOptions<AdditionalTools, RuntimeRequirements>
  readonly runnerToolkit: Toolkit.Toolkit<RunnerTools>
  readonly handlerLayer: Layer.Layer<
    HandlerServices,
    import("@rika/product/execution-service").BackendError,
    HandlerRequirements
  >
  readonly rikaToolRuntimeLayer: RikaToolRuntimeLayer<RuntimeRequirements>
  readonly sharedModelRegistryLayer: Layer.Layer<ModelRegistry.ModelRegistry>
}) => {
  const { relayClient, options, runnerToolkit, handlerLayer, rikaToolRuntimeLayer, sharedModelRegistryLayer } = input
  const credentials = options.webSearchCredentials ?? {}
  const search = WebSearchProvider.configuredProviderFactories(credentials)
  const readPageCredential = WebSearchProvider.configuredReadPageCredential(credentials)
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
                RelayToolRuntime.ToolExecutionFailed.make({ tool_name: context.call.name, message: String(cause) }),
              ),
            )
          return Context.make(
            ToolInvocation.ToolInvocation,
            ToolInvocation.ToolInvocation.of({
              executionId: String(context.executionId),
              callId: String(context.call.id),
              toolName: String(context.call.name),
              eventSequence: Number(context.eventSequence),
              createdAt: context.createdAt,
              idempotencyKeyDigest: Encoding.encodeHex(idempotencyKeyDigest),
            }),
          )
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
  return Layer.effect(
    RelayToolRuntime.HostService,
    Effect.gen(function* () {
      const host = yield* RelayToolRuntime.HostService
      const registered = yield* host.registeredTools
      return RelayToolRuntime.HostService.of({ registeredTools: Effect.succeed([...registered, subagentJoinTool]) })
    }),
  ).pipe(Layer.provide(handledToolRuntimeLayer))
}
