import { productLayer as makeProductLayer } from "@rika/product/product-operation-service"
import * as ProductStoreSummaryRepository from "@rika/product-store/sqlite-thread-summary-repository"
import * as TranscriptRepository from "@rika/product-store/sqlite-transcript-repository"

import { Effect, Layer } from "effect"

type ProductLayerOptions = Parameters<typeof makeProductLayer>[0]

export const productLayer = (options: ProductLayerOptions): ReturnType<typeof makeProductLayer> =>
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
