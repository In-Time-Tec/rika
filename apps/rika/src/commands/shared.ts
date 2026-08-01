import * as ProductOperation from "@rika/product/product-operation"
import * as Operation from "@rika/product/product-operation-service"
import { Effect } from "effect"

export const dispatch = Effect.fn("Cli.dispatch")(function* (input: ProductOperation.Input) {
  const operation = yield* Operation.Service
  yield* operation.run(input)
})
