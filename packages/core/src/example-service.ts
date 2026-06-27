import { Context, Effect, Layer, Schema } from "effect"

export class ExampleServiceError extends Schema.TaggedErrorClass<ExampleServiceError>()("ExampleServiceError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly greet: (name: string) => Effect.Effect<string, ExampleServiceError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/ExampleService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({
      greet: Effect.fn("ExampleService.greet")(function* (name: string) {
        const trimmed = name.trim()
        if (trimmed.length === 0) {
          return yield* Effect.fail(new ExampleServiceError({ message: "Name is required" }))
        }
        return `Hello, ${trimmed}`
      }),
    })
  }),
)

export const greet = Effect.fn("ExampleService.greet.call")(function* (name: string) {
  const service = yield* Service
  return yield* service.greet(name)
})
