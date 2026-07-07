import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { Cause, Clock, Context, Effect, Exit, Layer, Option, Schema } from "effect"
import { Common } from "@rika/schema"
import { Service as ConfigService } from "./config"
import * as SecretRedactor from "./secret-redactor"

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
  readonly redactEntry: (entry: Entry) => Entry
  readonly redactFields: (fields: Fields) => Fields
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
  Effect.gen(function* () {
    const path = yield* resolveLogPath()
    const redactor = yield* SecretRedactor.Service
    return makeService(redactor, makeFileEmit(redactor, path))
  }),
)

export const fileLayer = (path: string) =>
  Layer.effect(
    Service,
    Effect.map(SecretRedactor.Service, (redactor) => makeService(redactor, makeFileEmit(redactor, path))),
  )

export const stderrLayer = Layer.effect(
  Service,
  Effect.map(SecretRedactor.Service, (redactor) =>
    makeService(
      redactor,
      Effect.fn("Diagnostics.emit.stderr")(function* (entry: Entry) {
        yield* Effect.sync(() => {
          process.stderr.write(`${lineFromEntry(entry)}\n`)
        })
      }),
    ),
  ),
)

export const memoryLayer = (entries: Array<Entry>) =>
  Layer.effect(
    Service,
    Effect.map(SecretRedactor.Service, (redactor) =>
      makeService(
        redactor,
        Effect.fn("Diagnostics.emit.memory")(function* (entry: Entry) {
          yield* Effect.sync(() => entries.push(entry))
        }),
      ),
    ),
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
    const spanSeed = yield* redactFields({ ...seed, op })
    return yield* run(fields).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const endedAt = yield* Clock.currentTimeMillis
          const outcome = Exit.isSuccess(exit) ? "success" : "error"
          const data = yield* redactFields({
            ...fields,
            op,
            outcome,
            duration_ms: endedAt - startedAt,
            ...(Exit.isSuccess(exit) ? {} : { error: Cause.pretty(exit.cause) }),
          })
          yield* Effect.annotateCurrentSpan(attributesFromFields(data))
          yield* emit({
            level: outcome === "error" ? "error" : "info",
            message: `${op} ${outcome}`,
            data,
          })
        }),
      ),
      Effect.withSpan(op, { attributes: attributesFromFields(spanSeed) }),
    )
  })

export const makeFileEmit = (redactor: SecretRedactor.Interface, path: string) =>
  Effect.fn("Diagnostics.emit.file")(function* (entry: Entry) {
    const redacted = redactEntryWith(redactor, entry)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true })
        await appendFile(path, `${lineFromEntry(redacted)}\n`, "utf8")
      },
      catch: () => undefined,
    }).pipe(Effect.catch(() => Effect.void))
  })

export const makeService = (redactor: SecretRedactor.Interface, emitRedacted: (entry: Entry) => Effect.Effect<void>) =>
  Service.of({
    emit: Effect.fn("Diagnostics.emit")(function* (entry: Entry) {
      yield* emitRedacted(redactEntryWith(redactor, entry))
    }),
    redactEntry: (entry) => redactEntryWith(redactor, entry),
    redactFields: (fields) => redactFieldsWith(redactor, fields),
  })

export const redactEntry = Effect.fn("Diagnostics.redactEntry")(function* (entry: Entry) {
  const diagnostics = yield* Service
  return diagnostics.redactEntry(entry)
})

export const redactFields = Effect.fn("Diagnostics.redactFields")(function* (fields: Fields) {
  const diagnostics = yield* Service
  return diagnostics.redactFields(fields)
})

const redactEntryWith = (redactor: SecretRedactor.Interface, entry: Entry): Entry => ({
  level: entry.level,
  message: redactor.redact(entry.message),
  ...(entry.data === undefined ? {} : { data: redactor.redactJson(entry.data) }),
})

const redactFieldsWith = (redactor: SecretRedactor.Interface, fields: Fields): Fields => {
  const redacted: Fields = {}
  for (const [key, value] of Object.entries(fields)) redacted[key] = redactor.redactJson(value)
  return redacted
}

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
