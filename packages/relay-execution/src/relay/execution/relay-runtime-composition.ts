import { ModelHub } from "@relayfx/sdk"
import { lazyModelRegistryLayer } from "../../model/routing/relay-model-registry"
import { error } from "./relay-event-payload"
import { Cause, Context, Effect, Layer } from "effect"
import { ModelRegistry } from "@batonfx/core"
import { BackendError } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, LayerOptions } from "./relay-execution-layer"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ContextTokenizer from "../../context-tokenizer"
import { routedToolRuntimeLayer } from "./relay-tool-runtime"

export const buildModelContext: (
  registrations: ReadonlyArray<ModelRegistry.Registration>,
) => Effect.Effect<Context.Context<any>, any, any> = (registrations) =>
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
  readonly relayModelContext: Context.Context<any>
}) => {
  const { options, relayModelContext } = input
  const modelRegistry = Context.get(relayModelContext, ModelHub.Service).modelRegistry
  const languageModelLayer = Layer.mergeAll(Layer.succeedContext(relayModelContext), ContextTokenizer.layer)
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
