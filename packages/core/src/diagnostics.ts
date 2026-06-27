import { Context, Effect, Layer, Schema } from "effect"
import { Common } from "@rika/schema"

export const Level = Schema.Literals(["debug", "info", "warn", "error"]).annotate({
  identifier: "Rika.Diagnostics.Level",
})
export type Level = typeof Level.Type

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  level: Level,
  message: Schema.String,
  data: Schema.optional(Common.JsonValue),
}).annotate({ identifier: "Rika.Diagnostics.Entry" })

export interface Interface {
  readonly emit: (entry: Entry) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@rika/core/Diagnostics") {}

export const layer = Layer.succeed(
  Service,
  Service.of({
    emit: Effect.fn("Diagnostics.emit")(function* (entry: Entry) {
      yield* Effect.sync(() => {
        const line = entry.data === undefined ? entry.message : `${entry.message} ${JSON.stringify(entry.data)}`
        if (entry.level === "error") {
          console.error(line)
          return
        }
        if (entry.level === "warn") {
          console.warn(line)
          return
        }
        console.log(line)
      })
    }),
  }),
)

export const memoryLayer = (entries: Array<Entry>) =>
  Layer.succeed(
    Service,
    Service.of({
      emit: Effect.fn("Diagnostics.emit.memory")(function* (entry: Entry) {
        yield* Effect.sync(() => entries.push(entry))
      }),
    }),
  )

export const emit = Effect.fn("Diagnostics.emit.call")(function* (entry: Entry) {
  const diagnostics = yield* Service
  return yield* diagnostics.emit(entry)
})
