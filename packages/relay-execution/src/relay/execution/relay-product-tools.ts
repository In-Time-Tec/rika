import * as ThreadToolkits from "@rika/coding-tools/thread-tool-contract"
import { ThreadToolHandlers } from "@rika/product/product-operation-service"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ThreadToolService from "@rika/product/thread-tool-service"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/product/thread-search-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import type { LayerOptions } from "./relay-execution-layer"
import { makeRelayLayer } from "./relay-execution-composition"
import { Cause, Crypto, Effect, Function, Layer } from "effect"
import * as ExecutionBackend from "@rika/product/execution-service"

type RelayOptions<RuntimeRequirements extends import("./relay-execution-layer").ToolRuntimeRequirements = never> = Omit<
  LayerOptions<typeof ThreadToolkits.ThreadContract.allToolkit.tools, RuntimeRequirements>,
  "additionalToolkit" | "additionalHandlerLayer"
>
type Repositories = {
  readonly thread: Layer.Layer<ThreadRepository.Service, ThreadRepository.RepositoryError, never>
  readonly turn: Layer.Layer<TurnRepository.Service, TurnRepository.RepositoryError, never>
  readonly transcript: Layer.Layer<TranscriptRepository.Service, TranscriptRepository.RepositoryError, never>
  readonly search: Layer.Layer<ThreadSearchRepository.Service, ThreadSearchRepository.RepositoryError, never>
  readonly interaction: Layer.Layer<
    ThreadInteractionRepository.Service,
    ThreadInteractionRepository.RepositoryError,
    never
  >
}

const makeLayer = <RuntimeRequirements extends import("./relay-execution-layer").ToolRuntimeRequirements = never>(
  options: RelayOptions<RuntimeRequirements>,
  repositories: Repositories,
  gateway: ThreadToolService.Gateway,
): Layer.Layer<
  ExecutionBackend.Service,
  unknown,
  Crypto.Crypto | import("./relay-execution-layer").ExternalToolRuntimeRequirements<RuntimeRequirements>
> =>
  makeRelayLayer({
    ...options,
    additionalToolkit: ThreadToolkits.ThreadContract.allToolkit,
    additionalHandlerLayer: Layer.merge(
      Layer.merge(
        ThreadToolHandlers.handlerLayerForWorkspace(
          options.resolveWorkspace ?? (() => Effect.succeed(options.workspace ?? "")),
        ),
        ThreadToolHandlers.findHandlerLayerForWorkspace(
          options.resolveWorkspace ?? (() => Effect.succeed(options.workspace ?? "")),
        ),
      ).pipe(
        Layer.provide(
          ThreadQuery.Runtime.factoryLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                repositories.thread,
                repositories.turn,
                repositories.transcript,
                repositories.search,
                repositories.interaction,
              ),
            ),
          ),
        ),
      ),
      ThreadToolHandlers.coordinationHandlerLayer(gateway),
    ).pipe(
      Layer.catchCause((cause) =>
        Layer.effectContext(Effect.fail(ExecutionBackend.BackendError.make({ message: Cause.pretty(cause) }))),
      ),
    ),
  })

const relayBackendLayer: {
  <RuntimeRequirements extends import("./relay-execution-layer").ToolRuntimeRequirements = never>(
    repositories: Repositories,
    gateway: ThreadToolService.Gateway,
  ): (options: RelayOptions<RuntimeRequirements>) => ReturnType<typeof makeLayer<RuntimeRequirements>>
  <RuntimeRequirements extends import("./relay-execution-layer").ToolRuntimeRequirements = never>(
    options: RelayOptions<RuntimeRequirements>,
    repositories: Repositories,
    gateway: ThreadToolService.Gateway,
  ): ReturnType<typeof makeLayer<RuntimeRequirements>>
} = Function.dual(3, makeLayer)

export default { relayBackendLayer }
