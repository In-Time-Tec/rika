import { Clock, DateTime, Duration, Effect, FileSystem, Layer, Logger, Option, Path, Queue, References } from "effect"

export type ProcessRole = "client" | "resident"
export type LogLevel = "debug" | "info" | "warning" | "error"

export interface Status {
  readonly directory: string
  readonly files: number
  readonly bytes: bigint
}

const activeSettlers = new Set<() => void>()

type DiagnosticAnnotation = string | number | boolean

type AnnotationSchema = (value: unknown) => DiagnosticAnnotation | undefined

const oneOf = <A extends string>(...values: ReadonlyArray<A>): AnnotationSchema => {
  const accepted = new Set<string>(values)
  return (value) => (typeof value === "string" && accepted.has(value) ? value : undefined)
}

const boundedNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const boolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

const matching =
  (pattern: RegExp, maximum = 256): AnnotationSchema =>
  (value) =>
    typeof value === "string" && value.length <= maximum && pattern.test(value) ? value : undefined

const uuid = matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 36)
const threadOrTurnId = matching(
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|(?:thread|turn)-[a-z0-9][a-z0-9._-]{0,127})$/i,
  128,
)
const executionId = matching(/^(?:execution:|child:|auxiliary:)[a-z0-9][a-z0-9._:%-]{0,223}$/i, 256)
const eventCursor = matching(
  /^(?:start|(?:cursor|event|follow)[-:][a-z0-9][a-z0-9._:%-]{0,223}|[a-z0-9_-]{1,64}~[a-z0-9_-]{20})$/i,
  256,
)
const toolCallId = matching(/^(?:call[-_:]|id_)[a-z0-9][a-z0-9._:%-]{0,127}$/i, 160)

const knownFailureKinds = oneOf(
  "@rika/app/ExtensionOperationError",
  "@rika/extensions/McpConfigError",
  "@rika/extensions/McpDiagnostic",
  "@rika/extensions/McpOAuthError",
  "@rika/extensions/PluginContractError",
  "@rika/extensions/PluginDigestError",
  "@rika/extensions/PluginLoadError",
  "AgentToolError",
  "ArchivedThreadError",
  "BedrockAuthRefreshFailure",
  "ConfigFileError",
  "ConfigOperationsAdapterError",
  "Error",
  "ExecutionBackendError",
  "ExecutionIngestFailure",
  "ExecutionInspectionFailure",
  "ExecutionRecoveryAbandonmentFailure",
  "ExecutionStopCancelFailure",
  "ExternalBoundaryError",
  "FixtureProcessError",
  "InvalidInput",
  "LocalPathError",
  "MediaAnalysisError",
  "MediaMissingError",
  "MediaOversizedError",
  "ModelProviderRuntimeError",
  "ModelRouteError",
  "MultiAgentProcessFixtureError",
  "OpenAiAuthError",
  "OpenAiCredentialStoreError",
  "OperationError",
  "OperationUnavailable",
  "ParallelSearchError",
  "ProductAgentInvocationError",
  "ProductDatabaseError",
  "ProductWorkflowError",
  "ProjectionRecoveryFailure",
  "PromoteTurnError",
  "PromptAttachmentError",
  "QueuedTurnStartFailure",
  "QueuedTurnUnavailable",
  "RangeError",
  "ReadWebPageContentError",
  "ReadWebPageHttpError",
  "RecoveryProcessFixtureError",
  "RecoveredRootCancelFailure",
  "ResidentAbandonmentCancelFailure",
  "ResidentReplacementStatusFailure",
  "ResidentServiceError",
  "ReleaseUpdateError",
  "StaleQueuedTurns",
  "ThreadAdmissionRejected",
  "ThreadForkFailure",
  "ThreadInteractionQueueFull",
  "ThreadInteractionRepositoryError",
  "ThreadInvocationConflict",
  "ThreadNotFoundError",
  "ThreadQueryError",
  "ThreadRepositoryError",
  "ThreadResultNotReady",
  "ThreadSearchRepositoryError",
  "ThreadSummaryRepairFailure",
  "ThreadSummaryRepositoryError",
  "ThreadToolError",
  "ThreadToolGatewayUnavailable",
  "TokenExpiredError",
  "ToolError",
  "TranscriptRefoldStale",
  "TranscriptRepositoryError",
  "TuiAdapterError",
  "TurnQueueFull",
  "TurnRepositoryError",
  "TypeError",
  "UnsupportedMediaError",
  "UsageProjectionFailure",
  "UsageRepositoryError",
  "WebSearchExecutionError",
  "WebSearchProviderFailure",
  "WebSearchSelectionError",
  "WorkspaceFileError",
  "WorkflowProcessFixtureError",
  "WorkspaceIndexError",
  "boolean",
  "function",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
)

const annotationSchemas: Readonly<Record<string, AnnotationSchema>> = {
  "rika.duration.ms": boundedNumber,
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
  "rika.model.alias": oneOf(
    "main",
    "oracle",
    "title",
    "compaction",
    "librarian",
    "painter",
    "review",
    "readThread",
    "surgeon",
    "task",
  ),
  "rika.model.backend.kind": oneOf("configured", "test"),
  "rika.process.instance": matching(/^\d{1,16}-\d{1,10}$/, 32),
  "rika.process.pid": boundedNumber,
  "rika.process.role": oneOf("client", "resident"),
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
  "rika.resident.client.kind": oneOf("interactive", "run", "review", "workflow", "thread-continue", "product"),
  "rika.resident.command.sequence": boundedNumber,
  "rika.resident.connection.duration.ms": boundedNumber,
  "rika.resident.connection.failures": boundedNumber,
  "rika.resident.connection.id": uuid,
  "rika.resident.connection.retry": boundedNumber,
  "rika.resident.connection.retry_delay.ms": boundedNumber,
  "rika.resident.connection.role": oneOf("launch", "reattach"),
  "rika.resident.feed.fragments": boundedNumber,
  "rika.resident.feed.overflowed": boolean,
  "rika.resident.feed.queued": boundedNumber,
  "rika.resident.feed.sent": boundedNumber,
  "rika.resident.feed.sequence": boundedNumber,
  "rika.resident.generation": boundedNumber,
  "rika.resident.port": boundedNumber,
  "rika.resident.previous.pid": boundedNumber,
  "rika.resident.rejection.reason": oneOf("accepted", "incompatible", "active-execution-work"),
  "rika.resident.request.id": uuid,
  "rika.resident.session.id": uuid,
  "rika.resident.startup.pid": boundedNumber,
  "rika.resident.startup.role": oneOf("owner", "child", "reclaimer"),
  "rika.thread.id": threadOrTurnId,
  "rika.tool.call.id": toolCallId,
  "rika.tool.deadline.ms": boundedNumber,
  "rika.tool.dependency": oneOf("parallel", "sequential"),
  "rika.tool.name": oneOf(
    "await_subagents",
    "bash",
    "edit",
    "grep",
    "read",
    "read_thread",
    "read_thread_transcript",
    "read_web_page",
    "search_threads",
    "shell_command_status",
    "task",
    "view_media",
    "web_search",
    "write",
  ),
  "rika.tool.retry.attempt": boundedNumber,
  "rika.tool.retry.delay.ms": boundedNumber,
  "rika.turn.id": threadOrTurnId,
  "rika.version": matching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 64),
}

const safeAnnotation = (key: string, value: unknown): DiagnosticAnnotation | undefined =>
  annotationSchemas[key]?.(value)

const structuredLogger = Logger.make(({ date, fiber, logLevel, message }) => {
  const elements: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message]
  const [candidate] = elements
  const operation =
    typeof candidate === "string" && /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/.test(candidate) && candidate.length <= 100
      ? candidate
      : undefined
  const current = fiber.getRef(References.CurrentLogAnnotations)
  const annotations: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(current)) {
    const safe = safeAnnotation(key, value)
    if (safe !== undefined) annotations[key] = safe
  }
  return JSON.stringify({
    message: operation ?? "diagnostic.unstructured",
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
    const logFile = yield* fs.open(open, { flag: "ax", mode: 0o600 })
    const encoder = new TextEncoder()
    const wakeups = yield* Queue.sliding<void>(1)
    let buffer: Array<string> = []
    const flush = Effect.suspend(() => {
      if (buffer.length === 0) return Effect.void
      const chunk = buffer
      buffer = []
      return Effect.ignore(logFile.write(encoder.encode(`${chunk.join("\n")}\n`)))
    })
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          yield* Queue.take(wakeups)
          yield* Effect.sleep(Duration.seconds(1))
          yield* flush
        }
      }),
    )
    yield* Effect.addFinalizer(() => flush)
    return Logger.make((options_) => {
      buffer.push(structuredLogger.log(options_))
      Queue.offerUnsafe(wakeups, undefined)
    })
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
