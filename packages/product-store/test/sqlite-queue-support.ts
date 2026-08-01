import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { Effect, Layer } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TurnContract from "@rika/product/turn-repository"

export const id = Thread.ThreadId.make("thread-a")

export const create = (
  repository: TurnContract.Interface,
  input: Omit<Parameters<TurnContract.Interface["createForSubmission"]>[0], "executionRoute" | "queueCapacity"> & {
    readonly queueCapacity?: number
  },
): ReturnType<TurnContract.Interface["createForSubmission"]> =>
  repository.createForSubmission({
    queueCapacity: 128,
    ...input,
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  })

export const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })
