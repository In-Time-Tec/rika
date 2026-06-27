import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly next: (prefix: string) => Effect.Effect<string>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/IdGenerator") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    next: Effect.fn("IdGenerator.next")(function* (prefix: string) {
      return `${prefix}_${crypto.randomUUID()}`
    }),
  }),
)

export const sequenceLayer = (start = 1) => {
  let next = start
  return Layer.succeed(
    Service,
    Service.of({
      next: Effect.fn("IdGenerator.next.sequence")(function* (prefix: string) {
        const value = `${prefix}_${next}`
        next += 1
        return value
      }),
    }),
  )
}

export const next = Effect.fn("IdGenerator.next.call")(function* (prefix: string) {
  const generator = yield* Service
  return yield* generator.next(prefix)
})
