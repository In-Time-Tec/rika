import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"
import { Effect, Layer } from "effect"
import * as Thread from "@rika/product/thread-record"
import * as TurnContract from "@rika/product/turn-repository"

export const id = Thread.ThreadId.make("thread-a")

type CreateInput = Omit<
  Parameters<TurnContract.Interface["createForSubmission"]>[0],
  "executionRoute" | "queueCapacity"
> & {
  readonly queueCapacity?: number
}
type CreateResult = ReturnType<TurnContract.Interface["createForSubmission"]>

export function create(repository: TurnContract.Interface, input: CreateInput): CreateResult
export function create(input: CreateInput): (repository: TurnContract.Interface) => CreateResult
export function create(
  repositoryOrInput: TurnContract.Interface | CreateInput,
  input?: CreateInput,
): CreateResult | ((repository: TurnContract.Interface) => CreateResult) {
  if (!("createForSubmission" in repositoryOrInput)) {
    if (input !== undefined) throw new Error("Invalid turn creation arguments")
    return (repository) => create(repository, repositoryOrInput)
  }
  if (input === undefined) throw new Error("Invalid turn creation arguments")
  return repositoryOrInput.createForSubmission({
    queueCapacity: 128,
    ...input,
    executionRoute: ExecutionRouteSnapshot.testExecutionRoute(),
  })
}

export const provideLayer =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R | ROut>) =>
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      return yield* effect.pipe(Effect.provide(context))
    })
