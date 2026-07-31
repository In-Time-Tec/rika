import * as ThreadSummaryRepository from "@rika/product/thread-summary-repository"
import * as TranscriptRepository from "@rika/product/transcript-repository"
import * as UsageRepository from "@rika/product/usage-repository"
import * as ThreadInteractionRepository from "@rika/product/thread-interaction-repository"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ExecutionExtensions from "@rika/extensions/execution-extension-service"
import * as ExecutionBackend from "@rika/product/execution-service"
import { Context, Effect, Layer } from "effect"

export const buildProductOperationDependencies = (input: any) =>
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
