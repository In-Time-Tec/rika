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
  readonly executionRoute?: ExecutionRouteSnapshot.ExecutionRouteSnapshot
  readonly queueCapacity?: number
}

type CreateResult = ReturnType<TurnContract.Interface["createForSubmission"]>

export function create(repository: TurnContract.Interface, input: CurrentCreateInput): CreateResult
export function create(input: CurrentCreateInput): (repository: TurnContract.Interface) => CreateResult
export function create(
  repositoryOrInput: TurnContract.Interface | CurrentCreateInput,
  input?: CurrentCreateInput,
): CreateResult | ((repository: TurnContract.Interface) => CreateResult) {
  if (!("createForSubmission" in repositoryOrInput)) {
    if (input !== undefined) throw new Error("Invalid turn creation arguments")
    return (repository) => create(repository, repositoryOrInput)
  }
  if (input === undefined) throw new Error("Invalid turn creation arguments")
  return repositoryOrInput.createForSubmission({
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
    ...input,
    queueCapacity: input.queueCapacity ?? 128,
  })
}
