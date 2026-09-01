import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { ThreadContract } from "@rika/product/thread-tool-contract"

it.effect("owns the bounded user-facing thread finder contract", () =>
  Effect.gen(function* () {
    expect(Object.keys(ThreadContract.findToolkit.tools)).toEqual(["find_thread"])
    expect(Object.keys(ThreadContract.publicToolkit.tools)).toEqual(["find_thread"])
    expect(ThreadContract.findDefaultLimit).toBe(10)
    expect(ThreadContract.findMaximumLimit).toBe(50)
    yield* Effect.flip(Schema.decodeEffect(ThreadContract.FindThreadInput)({ query: "all", limit: 51 }))
  }),
)
