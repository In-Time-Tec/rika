import type { ProductLayerOptions } from "@rika/product/product-operation-service"
import { productLayer as makeProductLayer } from "@rika/product/product-operation-service"
import * as ProductStoreSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as ProductStoreUsageRepository from "@rika/product-store/sqlite-usage-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"

import { Effect, Layer } from "effect"

export const productLayer = <
  ThreadError extends Error,
  TurnError extends Error,
  BackendError extends Error,
  ThreadSummaryError extends Error = never,
  TranscriptError extends Error = never,
  ThreadInteractionError extends Error = never,
  UsageError extends Error = never,
>(
  options: ProductLayerOptions<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    ThreadInteractionError,
    UsageError
  >,
): ReturnType<typeof makeProductLayer> =>
  makeProductLayer({
    ...options,
    threadSummaryRepositoryLayer:
      options.threadSummaryRepositoryLayer ??
      ProductStoreSummaryRepository.memoryLayer.pipe(
        Layer.provide(Layer.merge(options.repositoryLayer, options.turnRepositoryLayer)),
        Layer.orDie,
      ),
    transcriptRepositoryLayer:
      options.transcriptRepositoryLayer ??
      TranscriptRepository.memoryLayerWithTurns.pipe(Layer.provide(options.turnRepositoryLayer), Layer.orDie),
    usageRepositoryLayer: options.usageRepositoryLayer ?? ProductStoreUsageRepository.memoryLayer.pipe(Layer.orDie),
  })

export const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer)
        return yield* Effect.provide(effect, context)
      }),
    )
