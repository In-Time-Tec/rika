import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import * as TurnContract from "@rika/product/turn-repository"
import { Effect, Layer } from "effect"

export const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })

export type CurrentCreateInput = Omit<
  Parameters<TurnContract.Interface["createForSubmission"]>[0],
  "executionRoute" | "queueCapacity"
> & {
  readonly executionRoute?: ExecutionRouteSnapshot.ExecutionRoutePin
  readonly queueCapacity?: number
}

export const create = (repository: TurnContract.Interface, input: CurrentCreateInput) =>
  repository.createForSubmission({
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })
