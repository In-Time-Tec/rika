import { Deferred, Effect } from "effect"
import { OperationUnavailable } from "../contract/product-operation"
import type { Input } from "../contract/product-operation"
import {
  runInteractiveOperation,
  runNoninteractiveOperation,
  runReviewOperation,
  runSystemOperation,
} from "./product-operation-run-branches"

export const makeProductOperationRun = (factory: any) => {
  const scheduleBeforeRun = (input: Input) => {
    if (input._tag !== "Interactive" && input._tag !== "Run" && input._tag !== "Review" && input._tag !== "Workflow")
      return Effect.void
    if (input._tag === "Interactive")
      return Effect.forkIn(
        Effect.sleep("2 seconds").pipe(
          Effect.andThen(factory.scheduleReconcile),
          Effect.flatMap((value: any) => Deferred.await(value)),
          Effect.andThen(factory.repairSummariesOnce),
        ),
        factory.ownerScope,
      ).pipe(Effect.asVoid)
    return Effect.gen(function* () {
      yield* Deferred.await(yield* factory.scheduleReconcile)
      yield* factory.repairSummariesOnce
    })
  }
  return Effect.fn("ProductOperation.product.run")(function* (input: Input) {
    yield* scheduleBeforeRun(input)
    if (input._tag === "Interactive" && factory.options.interactive !== undefined)
      return yield* runInteractiveOperation(factory, input)
    if (input._tag === "Run") return yield* runNoninteractiveOperation(factory, input)
    if (input._tag === "Review") return yield* runReviewOperation(factory, input)
    return yield* runSystemOperation(factory, input)
  }) as unknown as (input: Input) => Effect.Effect<void, OperationUnavailable, never>
}
