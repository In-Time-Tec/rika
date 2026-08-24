import { Effect, Schema } from "effect"
import { OperationUnavailable } from "../contract/product"
import type { Input } from "../contract/product"
import {
  runInteractiveOperation,
  runNoninteractiveOperation,
  runSystemOperation,
} from "./branches"
import type { ProductOperationRunFactory } from "./branches"

export const makeProductOperationRun = (
  factory: ProductOperationRunFactory,
): ((input: Input) => Effect.Effect<void, OperationUnavailable, never>) => {
  const typedRepairSummariesOnce: Effect.Effect<void, OperationUnavailable, never> = factory.repairSummariesOnce
  const scheduleBeforeRun = (input: Input) => {
    if (input._tag !== "Interactive" && input._tag !== "Run" && input._tag !== "Review") return Effect.void
    if (input._tag === "Interactive")
      return Effect.forkIn(typedRepairSummariesOnce, factory.ownerScope).pipe(Effect.asVoid)
    return typedRepairSummariesOnce
  }
  const run = Effect.fn("ProductOperation.product.run")(function* (input: Input) {
    yield* scheduleBeforeRun(input)
    if (input._tag === "Interactive" && factory.options.interactive !== undefined)
      return yield* runInteractiveOperation(factory, input)
    if (input._tag === "Run" || input._tag === "Review") return yield* runNoninteractiveOperation(factory, input)
    return yield* runSystemOperation(factory, input)
  })
  return (input: Input) =>
    run(input).pipe(
      Effect.mapError((error) =>
        Schema.is(OperationUnavailable)(error)
          ? error
          : OperationUnavailable.make({ operation: "ProductOperation", message: String(error) }),
      ),
    )
}
