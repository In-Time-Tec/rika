import * as Operation from "@rika/product/product-operation-service"
import { Effect } from "effect"

export const dispatch = Effect.fn("Cli.dispatch")(function* (input: Operation.Input) {
  const operation = yield* Operation.Service
  yield* operation.run(input)
})
