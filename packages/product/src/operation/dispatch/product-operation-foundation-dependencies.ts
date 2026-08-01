import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as UsageRepository from "@rika/product/usage-repository"
import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as ThreadRepository from "@rika/product/thread-repository"
import * as TurnRepository from "@rika/product/turn-repository"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Context, Effect, Layer, Scope } from "effect"
import type { ProductLayerOptions } from "./product-operation-options"
import type { OperationError } from "../operation-error"

export interface ProductOperationDependencies {
  readonly dependencyContext: Context.Context<
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | TranscriptRepository.Service
    | UsageRepository.Service
    | ThreadInteractionRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.ExecutionExtensionService
  >
  readonly acquiredDependencies: Layer.Layer<
    | ThreadRepository.Service
    | TurnRepository.Service
    | ThreadSummaryRepository.Service
    | TranscriptRepository.Service
    | UsageRepository.Service
    | ThreadInteractionRepository.Service
    | ResolvedContext.Service
    | ExecutionExtensions.ExecutionExtensionService
  >
  readonly rawBackend: ExecutionBackend.Interface
  readonly usageRepository: UsageRepository.Interface
  readonly extensionService: ExecutionExtensions.ExecutionExtensionInterface | undefined
  readonly threadInteractions: ThreadInteractionRepository.Interface | undefined
}

type ProductLayerInput<
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error,
  TranscriptError extends Error,
  ThreadInteractionError extends Error,
  UsageError extends Error,
> = {
  readonly options: ProductLayerOptions<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    ThreadInteractionError,
    UsageError
  >
  readonly ownerScope: Scope.Scope
}

export const buildProductOperationDependencies = <
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error,
  TranscriptError extends Error,
  ThreadInteractionError extends Error,
  UsageError extends Error,
>(
  input: ProductLayerInput<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    ThreadInteractionError,
    UsageError
  >,
): Effect.Effect<
  ProductOperationDependencies,
  | ThreadError
  | TurnError
  | BackendError
  | ThreadSummaryError
  | TranscriptError
  | ThreadInteractionError
  | UsageError
  | OperationError,
  never
> =>
  Effect.gen(function* () {
    const { options, ownerScope } = input
    const repositories = Layer.merge(options.repositoryLayer, options.turnRepositoryLayer)
    const threadSummaryRepositoryLayer =
      options.threadSummaryRepositoryLayer ?? ThreadSummaryRepository.memoryLayer.pipe(Layer.provide(repositories))
    const transcriptRepositoryLayer =
      options.transcriptRepositoryLayer ?? TranscriptRepository.memoryLayerWithTurns.pipe(Layer.provide(repositories))
    const usageRepositoryLayer = options.usageRepositoryLayer ?? UsageRepository.memoryLayer
    const dependencies = Layer.mergeAll(
      repositories,
      threadSummaryRepositoryLayer,
      transcriptRepositoryLayer,
      usageRepositoryLayer,
      options.threadInteractionRepositoryLayer ?? Layer.empty,
      options.resolvedContextLayer ??
        ResolvedContext.testLayer({ resolve: () => Effect.succeed({ sources: [], diagnostics: [], digest: "" }) }),
      options.executionExtensions?.layer ?? Layer.empty,
    )
    const dependencyContext = yield* Layer.buildWithScope(dependencies, ownerScope)
    const backendContext = yield* Layer.buildWithScope(options.backendLayer, ownerScope)
    return {
      dependencyContext,
      acquiredDependencies: Layer.succeedContext(dependencyContext),
      rawBackend: Context.get(backendContext, ExecutionBackend.Service),
      usageRepository: Context.get(dependencyContext, UsageRepository.Service),
      extensionService:
        options.executionExtensions === undefined
          ? undefined
          : Context.get(dependencyContext, ExecutionExtensions.ExecutionExtensionService),
      threadInteractions:
        options.threadInteractionRepositoryLayer === undefined
          ? undefined
          : Context.get(dependencyContext, ThreadInteractionRepository.Service),
    }
  })
