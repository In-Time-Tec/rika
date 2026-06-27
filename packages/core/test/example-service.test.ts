import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { ExampleService } from "../src/index"

const fakeLayer = Layer.succeed(
  ExampleService.Service,
  ExampleService.Service.of({
    greet: Effect.fn("FakeExampleService.greet")(function* (name: string) {
      return `Fake ${name}`
    }),
  }),
)

describe("ExampleService", () => {
  test("uses the live layer", async () => {
    const result = await Effect.runPromise(ExampleService.greet("Rika").pipe(Effect.provide(ExampleService.layer)))

    expect(result).toBe("Hello, Rika")
  })

  test("can be replaced with a fake layer", async () => {
    const result = await Effect.runPromise(ExampleService.greet("Rika").pipe(Effect.provide(fakeLayer)))

    expect(result).toBe("Fake Rika")
  })

  test("fails with a typed service error", async () => {
    const error = await Effect.runPromise(
      ExampleService.greet(" ").pipe(Effect.flip, Effect.provide(ExampleService.layer)),
    )

    expect(error).toBeInstanceOf(ExampleService.ExampleServiceError)
    expect(error.message).toBe("Name is required")
  })
})
