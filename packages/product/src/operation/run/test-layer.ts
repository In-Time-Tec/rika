import { Effect, Layer, Ref } from "effect"
import { Service } from "../contract/product-service"
import type { Input } from "../contract/product"

export const testLayer = (calls: Ref.Ref<ReadonlyArray<Input>>) =>
  Layer.succeed(
    Service,
    Service.of({
      run: Effect.fn("ProductOperation.test.run")(function* (input) {
        yield* Ref.update(calls, (current) => [...current, input])
      }),
    }),
  )
