import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Common } from "@rika/schema"
import { Service as ConfigService } from "./config"

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

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* ConfigService
    const values = yield* config.get
    const rikaLogFile = yield* config.requireEnv("RIKA_LOG_FILE").pipe(Effect.option)
    const configuredPath = Option.isSome(rikaLogFile)
      ? rikaLogFile
      : yield* config.requireEnv("AMP_LOG_FILE").pipe(Effect.option)
    const path = Option.getOrElse(configuredPath, () => `${values.data_dir}/logs/session.ndjson`)
    return fileService(path)
  }),
)

export const fileLayer = (path: string) => Layer.succeed(Service, fileService(path))

export const stderrLayer = Layer.succeed(
  Service,
  Service.of({
    emit: Effect.fn("Diagnostics.emit.stderr")(function* (entry: Entry) {
      yield* Effect.sync(() => {
        console.error(lineFromEntry(entry))
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

const fileService = (path: string) =>
  Service.of({
    emit: Effect.fn("Diagnostics.emit.file")(function* (entry: Entry) {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(path), { recursive: true })
          await appendFile(path, `${lineFromEntry(entry)}\n`, "utf8")
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void))
    }),
  })

const lineFromEntry = (entry: Entry) =>
  JSON.stringify({
    emitted_at: new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    ...(entry.data === undefined ? {} : { data: entry.data }),
  })
