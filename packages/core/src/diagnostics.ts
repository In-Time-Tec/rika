import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
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

export const resolveLogPath = Effect.fn("Diagnostics.resolveLogPath")(function* () {
  const config = yield* ConfigService
  const values = yield* config.get
  const rikaLogFile = yield* config.requireEnv("RIKA_LOG_FILE").pipe(Effect.option)
  const configuredPath = Option.isSome(rikaLogFile)
    ? rikaLogFile
    : yield* config.requireEnv("AMP_LOG_FILE").pipe(Effect.option)
  return Option.getOrElse(configuredPath, () => `${values.data_dir}/logs/session.ndjson`)
})

export const layer = Layer.effect(
  Service,
  Effect.map(resolveLogPath(), (path) => fileService(path)),
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

export type Fields = Record<string, Common.JsonValue>

export type AttributeValue = string | number | boolean
export type Attributes = Record<string, AttributeValue>

export const attributesFromFields = (fields: Fields): Attributes => {
  const attributes: Attributes = {}
  for (const [key, value] of Object.entries(fields)) {
    const attribute = attributeValue(value)
    if (attribute !== undefined) attributes[`rika.${key}`] = attribute
  }
  return attributes
}

export const event = <A, E, R>(
  op: string,
  run: (fields: Fields) => Effect.Effect<A, E, R>,
  seed: Fields = {},
): Effect.Effect<A, E, R | Service> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const fields: Fields = { ...seed }
    return yield* run(fields).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const endedAt = yield* Clock.currentTimeMillis
          const outcome = Exit.isSuccess(exit) ? "success" : "error"
          const data: Fields = {
            ...fields,
            op,
            outcome,
            duration_ms: endedAt - startedAt,
            ...(Exit.isSuccess(exit) ? {} : { error: Cause.pretty(exit.cause) }),
          }
          yield* Effect.annotateCurrentSpan(attributesFromFields(data))
          yield* emit({
            level: outcome === "error" ? "error" : "info",
            message: `${op} ${outcome}`,
            data,
          })
        }),
      ),
      Effect.withSpan(op, { attributes: attributesFromFields({ ...seed, op }) }),
    )
  })

export const makeFileEmit = (path: string) =>
  Effect.fn("Diagnostics.emit.file")(function* (entry: Entry) {
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, `${lineFromEntry(entry)}\n`, "utf8")
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.void))
  })

const fileService = (path: string) => Service.of({ emit: makeFileEmit(path) })

const attributeValue = (value: Common.JsonValue): AttributeValue | undefined => {
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (value === null) return undefined
  return JSON.stringify(value)
}

const lineFromEntry = (entry: Entry) =>
  JSON.stringify({
    emitted_at: new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    ...(entry.data === undefined ? {} : { data: entry.data }),
  })
