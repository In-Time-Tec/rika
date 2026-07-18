import { Clock, DateTime, Duration, Effect, FileSystem, Layer, Logger, Option, Path, References } from "effect"

export type ProcessRole = "client" | "resident"
export type LogLevel = "debug" | "info" | "warning" | "error"

export interface Status {
  readonly directory: string
  readonly files: number
  readonly bytes: bigint
}

const activeSettlers = new Set<() => void>()

const diagnosticAnnotations = new Set([
  "rika.duration.ms",
  "rika.event.cursor",
  "rika.event.type",
  "rika.failure.kind",
  "rika.failure.reason",
  "rika.model.alias",
  "rika.model.backend.kind",
  "rika.model.name",
  "rika.model.provider",
  "rika.model.registration_key",
  "rika.operation",
  "rika.process.instance",
  "rika.process.pid",
  "rika.process.role",
  "rika.resident.client.kind",
  "rika.resident.command.sequence",
  "rika.resident.command.tag",
  "rika.resident.connection.duration.ms",
  "rika.resident.connection.failures",
  "rika.resident.connection.id",
  "rika.resident.connection.retry",
  "rika.resident.connection.retry_delay.ms",
  "rika.resident.connection.role",
  "rika.resident.feed.fragments",
  "rika.resident.feed.overflowed",
  "rika.resident.feed.queued",
  "rika.resident.feed.sent",
  "rika.resident.feed.sequence",
  "rika.resident.generation",
  "rika.resident.port",
  "rika.resident.previous.pid",
  "rika.resident.rejection.reason",
  "rika.resident.request.id",
  "rika.resident.session.id",
  "rika.resident.shutdown.reason",
  "rika.resident.startup.pid",
  "rika.resident.startup.role",
  "rika.thread.id",
  "rika.turn.id",
  "rika.version",
])

const structuredLogger = Logger.make(({ date, fiber, logLevel, message }) => {
  const [candidate] = Array.isArray(message) ? message : [message]
  const operation =
    typeof candidate === "string" && /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/.test(candidate) && candidate.length <= 100
      ? candidate
      : "diagnostic.unstructured"
  const current = fiber.getRef(References.CurrentLogAnnotations)
  const annotations: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(current)) {
    if (
      diagnosticAnnotations.has(key) &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    )
      annotations[key] = value
  }
  return JSON.stringify({
    message: operation,
    level: logLevel.toUpperCase(),
    timestamp: date.toISOString(),
    annotations,
  })
})

export const settleActiveLogs = () => {
  for (const settle of activeSettlers) settle()
}

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

const isLogFile = (name: string) => name.endsWith(".jsonl") || name.endsWith(".bootstrap.log")

export const resolveDataRoot = Effect.fn("Logging.resolveDataRoot")(function* (
  productDatabase: string,
  relayDatabase: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (path.basename(productDatabase) !== "rika.db" || path.basename(relayDatabase) !== "relay.db")
    return yield* Effect.die("RIKA_DATABASE and RIKA_RELAY_DATABASE must name rika.db and relay.db")
  const productRoot = path.dirname(path.resolve(productDatabase))
  const relayRoot = path.dirname(path.resolve(relayDatabase))
  yield* Effect.all([
    fs.makeDirectory(productRoot, { recursive: true }),
    fs.makeDirectory(relayRoot, { recursive: true }),
  ])
  const [canonicalProductRoot, canonicalRelayRoot] = yield* Effect.all([
    fs.realPath(productRoot),
    fs.realPath(relayRoot),
  ])
  if (canonicalProductRoot !== canonicalRelayRoot)
    return yield* Effect.die("RIKA_DATABASE and RIKA_RELAY_DATABASE must use one data directory")
  return canonicalProductRoot
})

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
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined
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
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined
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
  const logger = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const diagnostics = yield* prepareDirectory(options.dataRoot)
    const timestamp = options.now === undefined ? yield* DateTime.now : DateTime.makeUnsafe(options.now)
    const now = DateTime.formatIso(timestamp).replace(/[:.]/g, "-")
    const closed = path.join(diagnostics, `${options.role}-${now}-${options.pid ?? process.pid}.jsonl`)
    const open = closed.replace(/\.jsonl$/, ".open.jsonl")
    const settle = () => {
      try {
        process.getBuiltinModule("fs").renameSync(open, closed)
      } catch {}
    }
    activeSettlers.add(settle)
    process.once("exit", settle)
    process.once("beforeExit", settle)
    yield* Effect.addFinalizer(() =>
      fs.rename(open, closed).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.sync(() => {
            process.removeListener("exit", settle)
            process.removeListener("beforeExit", settle)
            activeSettlers.delete(settle)
          }),
        ),
      ),
    )
    return yield* structuredLogger.pipe(
      Logger.toFile(open, { flag: "ax", mode: 0o600, batchWindow: Duration.seconds(1) }),
    )
  })
  return Layer.merge(
    Logger.layer([logger]),
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
