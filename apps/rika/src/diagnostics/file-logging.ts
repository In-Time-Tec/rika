import { annotationSchemaMap, type DiagnosticAnnotation } from "./file-logging-annotations"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Inspectable,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Queue,
  References,
  Semaphore,
  Scope,
  Schema,
} from "effect"
import { openDiagnosticFile } from "../platform/diagnostic-file-host"

export type ProcessRole = "client" | "server"
export type LogLevel = "debug" | "info" | "warning" | "error"

interface ActiveSettler {
  readonly graceful: Effect.Effect<void>
  readonly hardExit: () => void
}

const activeSettlers = new Set<ActiveSettler>()

const settlingSignals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const

/** bun-types 1.4 shadows process.removeListener with its memoryPressure overload; the EventEmitter surface still takes signals. */
const processEvents: NodeJS.EventEmitter = process

const detailLimit = 4_000

const secretPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/\b(Authorization|DPoP|Bearer)\b[:\s]+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/("?[A-Za-z_]*(?:token|secret|password|api[_-]?key|private)[A-Za-z_]*"?\s*[:=]\s*"?)[^"',\s}]+/gi, "$1[redacted]"],
  [/\b(?:sk|rk|ghp|gho|github_pat)[_-][A-Za-z0-9_-]{16,}\b/g, "[redacted]"],
]

/** Free text that goes to disk: obvious credentials removed, whitespace collapsed, length bounded. */
export const redactDetail = (text: string): string => {
  let value = text
  for (const [pattern, replacement] of secretPatterns) value = value.replace(pattern, replacement)
  value = value.replace(/[ \t]+/g, " ").trim()
  return value.length > detailLimit ? `${value.slice(0, detailLimit - 1)}…` : value
}

const operationSchema = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isMaxLength(100), Schema.isPattern(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/)),
)

const decodeAnnotation = Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))

const Record_ = Schema.Struct({
  message: Schema.String,
  level: Schema.String,
  timestamp: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  detail: Schema.optionalKey(Schema.String),
})
type Record_ = typeof Record_.Type
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Record_))
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Record_))

const structuredLogger = Logger.make(({ cause, date, fiber, logLevel, message }) => {
  const elements: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message]
  const [candidate, ...rest] = elements
  const operation = Option.getOrUndefined(operationSchema(candidate))
  const current = fiber.getRef(References.CurrentLogAnnotations)
  const annotations: Record<string, DiagnosticAnnotation> = {}
  for (const [key, value] of Object.entries(current)) {
    const decoded = Option.getOrUndefined(decodeAnnotation(value))
    const safe = decoded === undefined ? undefined : annotationSchemaMap.get(key)?.(decoded)
    if (safe !== undefined) annotations[key] = safe
  }
  const record: Record_ = {
    message: operation ?? "diagnostic.unstructured",
    level: logLevel.toUpperCase(),
    timestamp: date.toISOString(),
    annotations,
  }
  // WARN and above keep their text and cause, redacted; INFO and DEBUG stay whitelist-only to keep logs small.
  if (logLevel === "Warn" || logLevel === "Error" || logLevel === "Fatal") {
    const free = (operation === undefined ? elements : rest).map((part) => Inspectable.toStringUnknown(part, 0))
    if (cause.reasons.length > 0) free.push(Cause.pretty(cause))
    const detail = redactDetail(free.join("\n"))
    return encodeRecord(detail === "" ? record : { ...record, detail })
  }
  return encodeRecord(record)
})

export const settleActiveLogs = Effect.suspend(() =>
  Effect.forEach([...activeSettlers], ({ graceful }) => graceful, { concurrency: 1, discard: true }),
)

const effectLogLevel = (level: LogLevel) => {
  switch (level) {
    case "debug":
      return "Debug" as const
    case "info":
      return "Info" as const
    case "warning":
      return "Warn" as const
    case "error":
      return "Error" as const
  }
}

export const minimumLevel = effectLogLevel

interface DiagnosticPersistenceInterface {
  readonly logger: Logger.Logger<unknown, void>
  readonly start: Effect.Effect<void, PlatformError.PlatformError>
}

export class DiagnosticPersistence extends Context.Service<DiagnosticPersistence, DiagnosticPersistenceInterface>()(
  "@rika/cli/diagnostics/file-logging/DiagnosticPersistence",
) {}

export const start = DiagnosticPersistence.pipe(Effect.flatMap((persistence) => persistence.start))

const isLogFile = (name: string) => name.endsWith(".jsonl") || name.endsWith(".bootstrap.log")

export const directory = Effect.fn("Logging.directory")(function* (dataRoot: string) {
  const path = yield* Path.Path
  return path.join(dataRoot, "diagnostics")
})

const prepareDirectory = Effect.fn("Logging.prepareDirectory")(function* (dataRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const diagnostics = yield* directory(dataRoot)
  if (yield* fs.exists(diagnostics)) {
    if ((yield* Effect.result(fs.readLink(diagnostics)))._tag === "Success")
      return yield* Effect.die("Rika diagnostics path cannot be a symbolic link")
    const info = yield* fs.stat(diagnostics)
    const expectedUid = process.getuid?.()
    const uid = Option.getOrUndefined(info.uid)
    if (info.type !== "Directory" || (expectedUid !== undefined && uid !== expectedUid))
      return yield* Effect.die("Rika diagnostics path is not a directory owned by this user")
  } else {
    yield* fs.makeDirectory(diagnostics, { recursive: true, mode: 0o700 })
  }
  yield* fs.chmod(diagnostics, 0o700)
  const now = yield* Clock.currentTimeMillis
  const names = yield* fs.readDirectory(diagnostics)
  yield* Effect.forEach(
    names.filter((name) => isLogFile(name) && !name.includes(".open.")),
    (name) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const filename = path.join(diagnostics, name)
        const info = yield* fs.stat(filename)
        const modified = Option.getOrUndefined(info.mtime)
        if (info.type === "File" && modified !== undefined && now - modified.getTime() > 14 * 86_400_000)
          yield* fs.remove(filename)
      }).pipe(Effect.ignore),
    { concurrency: 8, discard: true },
  )
  return diagnostics
})

const availableLogFiles = Effect.fn("Logging.availableLogFiles")(function* (diagnostics: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const expectedUid = process.getuid?.()
  const files: Array<{ readonly name: string; readonly size: bigint }> = []
  for (const name of (yield* fs.readDirectory(diagnostics)).filter(isLogFile)) {
    const filename = path.join(diagnostics, name)
    if ((yield* Effect.result(fs.readLink(filename)))._tag === "Success") continue
    const info = yield* Effect.result(fs.stat(filename))
    if (
      info._tag === "Success" &&
      info.success.type === "File" &&
      (info.success.mode & 0o077) === 0 &&
      (expectedUid === undefined || Option.getOrUndefined(info.success.uid) === expectedUid)
    )
      files.push({ name, size: info.success.size })
  }
  return files
})

export const layer = (options: {
  readonly dataRoot: string
  readonly role: ProcessRole
  readonly version: string
  readonly level?: LogLevel
  readonly now?: Date
  readonly pid?: number
}) => {
  const runtime = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const scope = yield* Scope.Scope
    const encoder = new TextEncoder()
    const wakeups = yield* Queue.sliding<void>(1)
    const startLock = yield* Semaphore.make(1)
    const accepted: Array<string> = []
    let lifecycle: "buffering" | "open" | "settled" = "buffering"
    const logger = Logger.make((options_) => {
      if (lifecycle === "settled") return
      accepted.push(structuredLogger.log(options_))
      Queue.offerUnsafe(wakeups, undefined)
    })
    const startPersistence = startLock.withPermits(1)(
      Effect.gen(function* () {
        if (lifecycle !== "buffering") return
        const diagnostics = yield* prepareDirectory(options.dataRoot)
        const timestamp = options.now === undefined ? yield* DateTime.now : DateTime.makeUnsafe(options.now)
        const now = DateTime.formatIso(timestamp).replace(/[:.]/g, "-")
        const closed = path.join(diagnostics, `${options.role}-${now}-${options.pid ?? process.pid}.jsonl`)
        const open = closed.replace(/\.jsonl$/, ".open.jsonl")
        const logFile = openDiagnosticFile(open)
        yield* Effect.addFinalizer(() => Effect.sync(logFile.close))
        lifecycle = "open"
        const effectContext = yield* Effect.context<never>()
        let persisted = 0
        const writeAccepted = (end: number) => {
          if (persisted === end) return
          const bytes = encoder.encode(`${accepted.slice(persisted, end).join("\n")}\n`)
          logFile.write(bytes)
          persisted = end
        }
        const writeBuffered = Effect.sync(() => {
          if (lifecycle === "open") writeAccepted(accepted.length)
        })
        const writeLock = yield* Semaphore.make(1)
        const flush = writeLock.withPermits(1)(writeBuffered)
        const settle = () => {
          if (lifecycle === "settled") return
          lifecycle = "settled"
          try {
            writeAccepted(accepted.length)
            logFile.settle(closed)
          } catch (error) {
            logFile.close()
            throw error
          }
        }
        const graceful = writeLock.withPermits(1)(Effect.sync(settle))
        const hardExit = settle
        const settler = { graceful, hardExit }
        activeSettlers.add(settler)
        const signalSettlers = settlingSignals.map((signal) => {
          const onSignal = () => {
            Effect.runForkWith(effectContext)(
              graceful.pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (process.listenerCount(signal) !== 1) return
                    processEvents.removeListener(signal, onSignal)
                    process.kill(process.pid, signal)
                  }),
                ),
              ),
            )
          }
          process.on(signal, onSignal)
          return [signal, onSignal] as const
        })
        process.once("exit", hardExit)
        process.once("beforeExit", hardExit)
        yield* Effect.addFinalizer(() =>
          graceful.pipe(
            Effect.andThen(
              Effect.sync(() => {
                processEvents.removeListener("exit", hardExit)
                processEvents.removeListener("beforeExit", hardExit)
                for (const [signal, onSignal] of signalSettlers) processEvents.removeListener(signal, onSignal)
                activeSettlers.delete(settler)
              }),
            ),
          ),
        )
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            while (true) {
              yield* Queue.take(wakeups)
              yield* Effect.sleep(Duration.seconds(1))
              yield* flush
            }
          }),
        )
        yield* flush
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Scope.Scope, scope),
      ),
    )
    return { logger, start: startPersistence }
  })
  const persistence = Layer.effect(
    DiagnosticPersistence,
    Effect.map(runtime, ({ logger, start: startPersistence }) => ({ logger, start: startPersistence })),
  )
  return Layer.merge(
    Layer.merge(
      persistence,
      Logger.layer([Effect.map(DiagnosticPersistence, ({ logger }) => logger)]).pipe(Layer.provide(persistence)),
    ),
    Layer.succeed(References.MinimumLogLevel, effectLogLevel(options.level ?? "info")),
  )
}

export const status = Effect.fn("Logging.status")(function* (dataRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const diagnostics = yield* directory(dataRoot)
  if (!(yield* fs.exists(diagnostics))) return { directory: diagnostics, files: 0, bytes: 0n }
  if ((yield* Effect.result(fs.readLink(diagnostics)))._tag === "Success")
    return yield* Effect.die("Rika diagnostics path cannot be a symbolic link")
  const files = (yield* availableLogFiles(diagnostics)).filter(
    ({ name }) => !name.endsWith(`-${process.pid}.open.jsonl`),
  )
  return { directory: diagnostics, files: files.length, bytes: files.reduce((total, file) => total + file.size, 0n) }
})

export const exportLogs = Effect.fn("Logging.exportLogs")(function* (dataRoot: string, destination: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = yield* directory(dataRoot)
  const target = path.resolve(destination)
  yield* fs.makeDirectory(target, { recursive: false, mode: 0o700 })
  yield* fs.chmod(target, 0o700)
  if (!(yield* fs.exists(source))) return target
  if ((yield* Effect.result(fs.readLink(source)))._tag === "Success")
    return yield* Effect.die("Rika diagnostics path cannot be a symbolic link")
  const copyPass = Effect.fn("Logging.exportLogs.copyPass")(function* () {
    const files = (yield* availableLogFiles(source)).filter(({ name }) => !name.endsWith(`-${process.pid}.open.jsonl`))
    yield* Effect.forEach(
      files,
      ({ name }) =>
        Effect.gen(function* () {
          const output = path.join(target, name)
          if (yield* fs.exists(output)) return
          const copied = yield* Effect.result(fs.copyFile(path.join(source, name), output))
          if (copied._tag === "Success") yield* fs.chmod(output, 0o600)
        }),
      { concurrency: 4, discard: true },
    )
  })
  yield* copyPass()
  yield* copyPass()
  return target
})

export interface RecentFailure {
  readonly file: string
  readonly timestamp: string
  readonly level: string
  readonly message: string
  readonly detail: string | undefined
  readonly annotations: Record_["annotations"]
}

export interface RecentRun {
  readonly file: string
  readonly version: string | undefined
  readonly started: string | undefined
  readonly lastRecord: string | undefined
  readonly records: number
  readonly stages: ReadonlyArray<string>
  readonly failures: ReadonlyArray<RecentFailure>
}

/**
 * Reads the newest client log files and extracts what a support conversation needs: which version ran, what
 * lifecycle stages it reached, and every WARN/ERROR record with its detail. Records are already redacted on write.
 */
export const recentRuns = Effect.fn("Logging.recentRuns")(function* (dataRoot: string, limit: number) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const diagnostics = yield* directory(dataRoot)
  if (!(yield* fs.exists(diagnostics))) return []
  const files = (yield* availableLogFiles(diagnostics))
    .filter(({ name }) => name.startsWith("client-") && name.endsWith(".jsonl"))
    .map(({ name }) => name)
    .toSorted()
    .toReversed()
    .slice(0, limit)
  const runs: Array<RecentRun> = []
  for (const name of files) {
    const text = yield* fs.readFileString(path.join(diagnostics, name)).pipe(Effect.orElseSucceed(() => ""))
    const failures: Array<RecentFailure> = []
    const stages: Array<string> = []
    let version: string | undefined
    let started: string | undefined
    let lastRecord: string | undefined
    let records = 0
    for (const line of text.split("\n")) {
      const record = Option.getOrUndefined(decodeRecord(line))
      if (record === undefined) continue
      records += 1
      started ??= record.timestamp
      lastRecord = record.timestamp
      const recordVersion = record.annotations["rika.version"]
      if (recordVersion !== undefined) version ??= String(recordVersion)
      if (
        record.message.startsWith("hosted.") ||
        record.message.startsWith("tui.") ||
        record.message.startsWith("cli.")
      )
        stages.push(record.message)
      if (record.level === "WARN" || record.level === "ERROR" || record.level === "FATAL")
        failures.push({
          file: name,
          timestamp: record.timestamp,
          level: record.level,
          message: record.message,
          detail: record.detail,
          annotations: record.annotations,
        })
    }
    runs.push({ file: name, version, started, lastRecord, records, stages, failures })
  }
  return runs
})
