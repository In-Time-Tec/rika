import { ModelHub } from "@relayfx/sdk"
import { lazyModelRegistryLayer } from "../../model/routing/relay-model-registry"
import { error } from "./relay-event-payload"
import { Cause, Context, Effect, Layer, Scope } from "effect"
import { ModelRegistry, ModelResilience } from "@batonfx/core"
import { BackendError } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, LayerOptions } from "./relay-execution-layer"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ContextTokenizer from "../../context-tokenizer"
import { routedToolRuntimeLayer } from "./relay-tool-runtime"

export type RelayModelContext = Context.Context<
  ModelHub.Service | ModelRegistry.ModelRegistry | import("@relayfx/sdk").LanguageModelService.Service
>

export const buildModelContext = (
  registrations: ReadonlyArray<ModelRegistry.Registration>,
): Effect.Effect<RelayModelContext, BackendError, Scope.Scope> =>
  Layer.build(
    Layer.unwrap(
      Layer.build(lazyModelRegistryLayer(registrations)).pipe(
        Effect.map((context) => ModelHub.testLayer(Context.get(context, ModelRegistry.ModelRegistry))),
      ),
    ),
  ).pipe(Effect.mapError(error))

export const makeModelRuntimeComposition = <
  AdditionalTools extends Record<string, import("effect/unstable/ai").Tool.Any>,
  RuntimeRequirements extends ToolRuntimeRequirements,
>(input: {
  readonly options: LayerOptions<AdditionalTools, RuntimeRequirements>
  readonly relayModelContext: RelayModelContext
}): {
  readonly languageModelLayer: Layer.Layer<import("@relayfx/sdk").LanguageModelService.Service, never, never>
  readonly sharedModelRegistryLayer: Layer.Layer<ModelRegistry.ModelRegistry, never, never>
  readonly rikaToolRuntimeLayer: Layer.Layer<
    RikaToolRuntime.Service,
    BackendError,
    ToolRuntimeRequirements | RuntimeRequirements
  >
  readonly modelRegistry: ModelRegistry.Interface
} => {
  const { options, relayModelContext } = input
  const modelRegistry = Context.get(relayModelContext, ModelHub.Service).modelRegistry
  const languageModelLayer = Layer.mergeAll(
    Layer.succeedContext(relayModelContext),
    ContextTokenizer.layer,
    ...(options.modelResilience === undefined
      ? []
      : [Layer.succeed(ModelResilience.ModelResilience, options.modelResilience)]),
  )
  const sharedModelRegistryLayer = Layer.succeed(ModelRegistry.ModelRegistry, modelRegistry)
  const rikaToolRuntimeLayer =
    options.toolRuntimeLayerForWorkspace !== undefined && options.resolveWorkspace !== undefined
      ? routedToolRuntimeLayer({
          layerForWorkspace: options.toolRuntimeLayerForWorkspace,
          resolveWorkspace: options.resolveWorkspace,
        })
      : (options.toolRuntimeLayer ??
        RikaToolRuntime.layer(options.workspace).pipe(
          Layer.catchCause((cause) =>
            Layer.effectContext(Effect.fail(BackendError.make({ message: Cause.pretty(cause) }))),
          ),
        ))
  return { languageModelLayer, sharedModelRegistryLayer, rikaToolRuntimeLayer, modelRegistry }
}
