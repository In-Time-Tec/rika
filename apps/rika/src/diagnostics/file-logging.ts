import * as Diagnostic from "./file-logging-contract"
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
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

type DiagnosticAnnotation = string | number | boolean

const annotation = <A extends DiagnosticAnnotation>(schema: Schema.Codec<A>) => {
  const decode = Schema.decodeUnknownOption(schema)
  return (value: DiagnosticAnnotation) => Option.getOrUndefined(decode(value))
}

const oneOf = <A extends string>(...values: ReadonlyArray<A>) => annotation(Schema.Literals(values))

const boundedNumber = annotation(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))

const boolean = annotation(Schema.Boolean)

const matching = (pattern: RegExp, maximum = 256) =>
  annotation(Schema.String.check(Schema.isMaxLength(maximum), Schema.isPattern(pattern)))

const uuid = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 36)
const executionId = matching(
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:run|turn)-[a-z0-9][a-z0-9._-]{0,223})$/i,
  256,
)
const eventCursor = matching(
  /^(?:start|(?:cursor|event|follow)[-:][a-z0-9][a-z0-9._:%-]{0,223}|[a-z0-9_-]{1,64}~[a-z0-9_-]{20})$/i,
  256,
)
const toolCallId = matching(/^(?:call[-_:]|id_)[a-z0-9][a-z0-9._:%-]{0,127}$/i, 160)
const hostedCorrelationId = matching(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/, 128)

const knownFailureKinds = oneOf(...Diagnostic.failureKinds)

const annotationSchemas = {
  "rika.duration.ms": boundedNumber,
  "rika.duration.millis": boundedNumber,
  "rika.event.cursor": eventCursor,
  "rika.event.type": matching(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/, 100),
  "rika.execution.id": executionId,
  "rika.failure.category": oneOf(
    "invalid_input",
    "not_found",
    "conflict",
    "access_denied",
    "dependency_unavailable",
    "rate_limited",
    "timeout",
    "operation",
  ),
  "rika.failure.interrupted": boolean,
  "rika.failure.kind": knownFailureKinds,
  "rika.failure.outcome": oneOf("known", "unknown"),
  "rika.follow.cursor": eventCursor,
  "rika.follow.reason": oneOf("thread-open", "reattach", "resume", "recovery"),
  "rika.follow.scope": oneOf("execution", "tree"),
  "rika.hosted.outcome": oneOf("success", "failure", "interrupted", "unknown"),
  "rika.hosted.stage": oneOf(
    "process_start",
    "first_draw",
    "target_resolution",
    "attach",
    "admission",
    "turn_claim",
    "run_created",
    "model_start",
    "model_terminal",
    "cell_admission",
    "cell_execution",
    "binding_send",
    "binding_terminal",
    "terminal",
  ),
  "rika.http.status": boundedNumber,
  "rika.binding.id": hostedCorrelationId,
  "rika.cell.id": hostedCorrelationId,
  "rika.model_attempt.id": hostedCorrelationId,
  "rika.model.selection": oneOf(
    "main",
    "oracle",
    "title",
    "compaction",
    "librarian",
    "painter",
    "readThread",
    "surgeon",
    "task",
  ),
  "rika.model.backend.kind": oneOf(...Diagnostic.modelBackendKinds),
  "rika.operation.id": hostedCorrelationId,
  "rika.process.instance": matching(/^\d{1,16}-\d{1,10}$/, 32),
  "rika.process.pid": boundedNumber,
  "rika.process.role": oneOf("client", "server"),
  "rika.reconciliation.certified": boolean,
  "rika.reconciliation.children.confirmed": boundedNumber,
  "rika.reconciliation.children.inspected": boundedNumber,
  "rika.reconciliation.children.pending": boundedNumber,
  "rika.reconciliation.children.replayed": boundedNumber,
  "rika.reconciliation.cursor.confirmed": boolean,
  "rika.reconciliation.cursor.initial": eventCursor,
  "rika.reconciliation.cursor.replayed": eventCursor,
  "rika.reconciliation.history.complete": boolean,
  "rika.reconciliation.inspection.confirmed": boolean,
  "rika.reconciliation.status.stable": boolean,
  "rika.reconciliation.status.terminal": boolean,
  "rika.reconciliation.terminal": boolean,
  "rika.reconciliation.tree.verified": boolean,
  "rika.reconnect.attempt": boundedNumber,
  "rika.reconnect.delay.ms": boundedNumber,
  "rika.retry_after.ms": boundedNumber,
  "rika.run.id": hostedCorrelationId,
  "rika.server.client.kind": oneOf("interactive", "run", "thread-continue", "product"),
  "rika.server.command.sequence": boundedNumber,
  "rika.server.connection.duration.ms": boundedNumber,
  "rika.server.connection.failures": boundedNumber,
  "rika.server.connection.id": uuid,
  "rika.server.connection.retry": boundedNumber,
  "rika.server.connection.retry_delay.ms": boundedNumber,
  "rika.server.connection.role": oneOf("launch", "reattach"),
  "rika.server.feed.fragments": boundedNumber,
  "rika.server.feed.overflowed": boolean,
  "rika.server.feed.queued": boundedNumber,
  "rika.server.feed.sent": boundedNumber,
  "rika.server.feed.sequence": boundedNumber,
  "rika.server.generation": boundedNumber,
  "rika.server.port": boundedNumber,
  "rika.server.previous.pid": boundedNumber,
  "rika.server.rejection.reason": oneOf("AuthenticationFailed", "BuildMismatch", "IdentityMismatch"),
  "rika.server.request.id": uuid,
  "rika.server.session.id": uuid,
  "rika.server.startup.pid": boundedNumber,
  "rika.server.startup.role": oneOf("owner", "child", "reclaimer"),
  "rika.thread.id": hostedCorrelationId,
  "rika.tool.call.id": toolCallId,
  "rika.tool.deadline.ms": boundedNumber,
  "rika.tool.dependency": oneOf("parallel", "sequential"),
  "rika.tool.name": oneOf(
    "bash",
    "code_mode",
    "edit",
    "grep",
    "read",
    "read_thread_transcript",
    "read_web_page",
    "run_child",
    "run_child_group",
    "search_threads",
    "shell_command_status",
    "view_media",
    "web_search",
    "write",
  ),
  "rika.tool.retry.attempt": boundedNumber,
  "rika.tool.retry.delay.ms": boundedNumber,
  "rika.turn.id": hostedCorrelationId,
  "rika.version": matching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 64),
} satisfies Readonly<Record<string, (value: DiagnosticAnnotation) => DiagnosticAnnotation | undefined>>
const annotationSchemaMap = new Map<string, (value: DiagnosticAnnotation) => DiagnosticAnnotation | undefined>(
  Object.entries(annotationSchemas),
)

const safeAnnotation = (key: string, value: DiagnosticAnnotation): DiagnosticAnnotation | undefined =>
  annotationSchemaMap.get(key)?.(value)

const structuredLogger = Logger.make(({ date, fiber, logLevel, message }) => {
  const elements: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message]
  const [candidate] = elements
  const operation = Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.String.check(Schema.isMaxLength(100), Schema.isPattern(/^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/)),
    )(candidate),
  )
  const current = fiber.getRef(References.CurrentLogAnnotations)
  const annotations: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(current)) {
    const decoded = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))(value),
    )
    const safe = decoded === undefined ? undefined : safeAnnotation(key, decoded)
    if (safe !== undefined) annotations[key] = safe
  }
  return JSON.stringify({
    message: operation ?? "diagnostic.unstructured",
    level: logLevel.toUpperCase(),
    timestamp: date.toISOString(),
    annotations,
  })
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
