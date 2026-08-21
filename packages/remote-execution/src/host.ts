import { BunFileSystem } from "@effect/platform-bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import { CellExecutor, layer as kernelCellLayer } from "@rika/kernel/cell-executor"
import {
  Cause,
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { CellError, Cells, State as CellState, layer as cellsLayer, type State as CellStateValue } from "./cells"
import { Runtime, layer as runtimeLayer } from "./runtime"
import {
  ApiMessage,
  type ApiMessage as IncomingMessage,
  CellLifecycleFrame,
  ExecutorBootstrapWire,
  type Fence,
  ExecutorMessage,
  SessionWire,
  Target,
  type CellRequest,
} from "./protocol"

interface Config {
  readonly fence: Fence
  readonly templateBuildId: string | null
  readonly apiUrl: string
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly workspaceId: string
  readonly stateDirectory: string
  readonly restoredSession?: SessionWire
}

interface Identity {
  readonly target: Target
  readonly assignmentId: string
  readonly assignmentGeneration: number
  readonly instanceId: string
  readonly executorId: string
  readonly templateBuildId: string | null
  readonly apiUrl: string
  readonly workspaceId: string
  readonly stateDirectory: string
}

interface Bootstrap {
  readonly credential: Redacted.Redacted<string>
  readonly identity: Identity
}

export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
}) {}

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const decodeBootstrap = Schema.decodeUnknownEffect(ExecutorBootstrapWire)
const encodeExecutorMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorMessage))
const decodeCellState = Schema.decodeUnknownEffect(Schema.fromJsonString(CellState))
const encodeCellState = Schema.encodeEffect(Schema.fromJsonString(CellState))
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionWire))
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(SessionWire))
const OperationReceiptSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  receipts: Schema.Array(
    Schema.Struct({
      operationKey: Schema.String.check(Schema.isMinLength(1)),
      frames: Schema.Array(CellLifecycleFrame),
    }),
  ),
})
const decodeOperationReceipts = Schema.decodeUnknownEffect(Schema.fromJsonString(OperationReceiptSnapshot))
const encodeOperationReceipts = Schema.encodeEffect(Schema.fromJsonString(OperationReceiptSnapshot))
const executorStateDirectory = "/var/lib/rika-executor"
const cellStateDirectory = `${executorStateDirectory}/cells`
const directoryMode = 0o700
const fileMode = 0o600
const sandboxIdPath = "/run/e2b/.E2B_SANDBOX_ID"
const workspaceRoot = "/workspace"

const sandboxInstanceId = () =>
  Bun.file(sandboxIdPath)
    .text()
    .then((value) => value.trim())
    .catch(() => Bun.env.E2B_SANDBOX_ID ?? "")

const required = (name: string) => {
  const value = Bun.env[name]
  return value === undefined || value.length === 0
    ? Effect.fail(HostError.make({ message: `${name} is required` }))
    : Effect.succeed(value)
}

const executorIdentity = Effect.gen(function* () {
  const target = yield* Effect.flatMap(required("RIKA_EXECUTOR_TARGET"), (value) =>
    Schema.decodeUnknownEffect(Target)(value).pipe(
      Effect.mapError(() => HostError.make({ message: "RIKA_EXECUTOR_TARGET is invalid" })),
    ),
  )
  const assignmentId = yield* required("RIKA_EXECUTOR_ASSIGNMENT_ID")
  const generationText = yield* required("RIKA_EXECUTOR_GENERATION")
  const assignmentGeneration = Number(generationText)
  if (!Number.isSafeInteger(assignmentGeneration) || assignmentGeneration < 1)
    return yield* HostError.make({ message: "RIKA_EXECUTOR_GENERATION is invalid" })
  return {
    target,
    assignmentId,
    assignmentGeneration,
    instanceId: target === "e2b" ? yield* required("E2B_SANDBOX_ID") : yield* required("RIKA_EXECUTOR_INSTANCE_ID"),
    executorId: yield* required("RIKA_EXECUTOR_ID"),
    templateBuildId: target === "e2b" ? yield* required("RIKA_EXECUTOR_TEMPLATE_BUILD_ID") : null,
    apiUrl: yield* required("RIKA_EXECUTOR_API_URL"),
    workspaceId: yield* required("RIKA_EXECUTOR_WORKSPACE_ID"),
    stateDirectory: Bun.env.RIKA_EXECUTOR_STATE_DIRECTORY || executorStateDirectory,
  } satisfies Identity
})

const restores = (identity: Identity, session: SessionWire) =>
  session.fence.target === identity.target &&
  session.fence.assignmentId === identity.assignmentId &&
  session.fence.assignmentGeneration === identity.assignmentGeneration &&
  session.fence.instanceId === identity.instanceId &&
  session.fence.executorId === `${identity.executorId}:${session.fence.processIncarnation}`

const configuration = (identity: Identity, bootstrapToken: Redacted.Redacted<string>, restoredSession?: SessionWire) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const processIncarnation =
      restoredSession === undefined
        ? yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(() => HostError.make({ message: "Could not create the process incarnation" })),
          )
        : restoredSession.fence.processIncarnation
    return {
      fence: {
        target: identity.target,
        assignmentId: identity.assignmentId,
        assignmentGeneration: identity.assignmentGeneration,
        instanceId: identity.instanceId,
        executorId: `${identity.executorId}:${processIncarnation}`,
        processIncarnation,
      },
      templateBuildId: identity.templateBuildId,
      apiUrl: identity.apiUrl,
      bootstrapToken,
      workspaceId: identity.workspaceId,
      stateDirectory: identity.stateDirectory,
      ...(restoredSession === undefined ? {} : { restoredSession }),
    } satisfies Config
  })

export interface SessionStore {
  readonly load: Effect.Effect<Option.Option<SessionWire>, HostError>
  readonly save: (session: SessionWire) => Effect.Effect<void, HostError>
}

export const sessionStore = (stateDirectory: string): Effect.Effect<SessionStore, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const filename = `${stateDirectory}/session.json`
    const restrictDirectory = fileSystem.makeDirectory(stateDirectory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fileSystem.chmod(stateDirectory, directoryMode)),
      Effect.mapError(() => HostError.make({ message: "Could not secure executor session state" })),
    )
    const load = restrictDirectory.pipe(
      Effect.andThen(
        fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => HostError.make({ message: "Could not inspect executor session state" }))),
      ),
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.chmod(filename, fileMode).pipe(
              Effect.andThen(fileSystem.readFileString(filename)),
              Effect.mapError(() => HostError.make({ message: "Could not read executor session state" })),
              Effect.flatMap((text) =>
                decodeSession(text).pipe(
                  Effect.mapError(() => HostError.make({ message: "Executor session state is invalid" })),
                  Effect.map(Option.some),
                ),
              ),
            )
          : Effect.succeedNone,
      ),
    )
    const save = Effect.fn("Host.sessionStore.save")(function* (session: SessionWire) {
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeSession(session).pipe(
        Effect.mapError(() => HostError.make({ message: "Could not encode executor session state" })),
      )
      yield* restrictDirectory
      yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, fileMode)),
        Effect.andThen(fileSystem.rename(temporary, filename)),
        Effect.andThen(fileSystem.chmod(filename, fileMode)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => HostError.make({ message: "Could not persist executor session state" })),
      )
    })
    return { load, save } satisfies SessionStore
  })

export interface OperationReceiptStore {
  readonly load: Effect.Effect<Map<string, ReadonlyArray<CellLifecycleFrame>>, HostError>
  readonly save: (frames: Map<string, ReadonlyArray<CellLifecycleFrame>>) => Effect.Effect<void, HostError>
}

const operationReceiptStore = (
  stateDirectory: string,
  assignmentId: string,
  assignmentGeneration: number,
): Effect.Effect<OperationReceiptStore, never, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto
    const directory = `${stateDirectory}/operation-receipts`
    const assignmentDigest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(assignmentId))
      .pipe(Effect.orDie)
    const filename = `${directory}/assignment-${Encoding.encodeHex(assignmentDigest)}-g${assignmentGeneration}.json`
    const restrictDirectory = fileSystem.makeDirectory(directory, { recursive: true, mode: directoryMode }).pipe(
      Effect.andThen(fileSystem.chmod(directory, directoryMode)),
      Effect.mapError(() => HostError.make({ message: "Could not secure executor operation receipts" })),
    )
    const load = restrictDirectory.pipe(
      Effect.andThen(
        fileSystem
          .exists(filename)
          .pipe(Effect.mapError(() => HostError.make({ message: "Could not inspect executor operation receipts" }))),
      ),
      Effect.flatMap((exists) =>
        exists
          ? fileSystem.chmod(filename, fileMode).pipe(
              Effect.andThen(fileSystem.readFileString(filename)),
              Effect.mapError(() => HostError.make({ message: "Could not read executor operation receipts" })),
              Effect.flatMap((text) =>
                decodeOperationReceipts(text).pipe(
                  Effect.mapError(() => HostError.make({ message: "Executor operation receipts are invalid" })),
                ),
              ),
              Effect.map(
                (snapshot) =>
                  new Map(snapshot.receipts.map((receipt) => [receipt.operationKey, receipt.frames] as const)),
              ),
            )
          : Effect.succeed(new Map()),
      ),
    )
    const save = Effect.fn("Host.operationReceiptStore.save")(function* (
      frames: Map<string, ReadonlyArray<CellLifecycleFrame>>,
    ) {
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeOperationReceipts({
        version: 1,
        receipts: [...frames].map(([operationKey, retained]) => ({ operationKey, frames: retained })),
      }).pipe(Effect.mapError(() => HostError.make({ message: "Could not encode executor operation receipts" })))
      yield* restrictDirectory
      yield* fileSystem.writeFileString(temporary, text, { mode: fileMode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, fileMode)),
        Effect.andThen(fileSystem.rename(temporary, filename)),
        Effect.andThen(fileSystem.chmod(filename, fileMode)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => HostError.make({ message: "Could not persist executor operation receipts" })),
      )
    })
    return { load, save } satisfies OperationReceiptStore
  })

const persistSession = (store: SessionStore) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const session = yield* runtime.persistedSession.pipe(
      Effect.mapError((cause) => HostError.make({ message: cause.message })),
    )
    yield* store.save(session)
  })

const waitForWelcome = (
  incoming: Queue.Queue<IncomingMessage>,
  store: SessionStore,
): Effect.Effect<void, HostError, Runtime | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
    if (message._tag === "ExecutorWelcome") {
      yield* runtime
        .welcome(message.welcome)
        .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
      yield* persistSession(store)
      return
    }
    if (message._tag === "ExecutorReconnected") {
      yield* runtime
        .reconnected(message.welcome)
        .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
      yield* persistSession(store)
      return
    }
    return yield* waitForWelcome(incoming, store)
  })

const sameAccess = (
  left: { readonly fence: Fence; readonly leaseEpoch: number; readonly sessionToken: string },
  right: typeof left,
) =>
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.target === right.fence.target &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const attribution = (request: CellRequest) => ({
  operationKey: request.operationKey,
  workspaceId: request.workspaceId,
  sessionId: request.sessionId,
  threadId: request.threadId,
  turnId: request.turnId,
  runId: request.runId,
  rootRunId: request.rootRunId,
  toolCallId: request.toolCallId,
  attempt: request.attempt,
})

const sameAttribution = (left: ReturnType<typeof attribution>, right: ReturnType<typeof attribution>) =>
  left.operationKey === right.operationKey &&
  left.workspaceId === right.workspaceId &&
  left.sessionId === right.sessionId &&
  left.threadId === right.threadId &&
  left.turnId === right.turnId &&
  left.runId === right.runId &&
  left.rootRunId === right.rootRunId &&
  left.toolCallId === right.toolCallId &&
  left.attempt === right.attempt

const redactOutput = (value: unknown) => {
  const text = (typeof value === "string" ? value : JSON.stringify(value))
    .replace(/(token|password|secret|authorization)["']?\s*[:=]\s*["'][^"']+/gi, "$1=REDACTED")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "REDACTED")
  return { text: text.slice(0, 16_384), truncated: text.length > 16_384 }
}

const consumeApi = (
  incoming: Queue.Queue<IncomingMessage>,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  store: SessionStore,
  receipts: OperationReceiptStore,
  operations: Ref.Ref<Map<string, Fiber.Fiber<void, unknown>>>,
  frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>,
  lifecycle: Semaphore.Semaphore,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const cells = yield* Cells
    const emit = (access: CellRequest["access"], frame: CellLifecycleFrame) =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(frames)
          const retained = current.get(frame.attribution.operationKey) ?? []
          if (retained.some((known) => known._tag === "Terminal") || frame.cursor !== retained.length + 1) return false
          const next = new Map(current)
          next.set(frame.attribution.operationKey, [...retained, frame])
          yield* Ref.set(frames, next)
          yield* receipts.save(next)
          yield* writer(encodeExecutorMessage({ _tag: "CellLifecycle", access, frame })).pipe(
            Effect.mapError(() => HostError.make({ message: "Could not write cell lifecycle frame" })),
          )
          return true
        }),
      )
    const loop = Effect.gen(function* () {
      const message = yield* Queue.take(incoming)
      if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
      if (message._tag === "LeaseReceipt") {
        yield* runtime
          .receipt(message.receipt)
          .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
        yield* persistSession(store)
      }
      if (message._tag === "CellExecute") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (!sameAccess(access, message.request.access))
          return yield* HostError.make({ message: "Cell request has a stale executor fence" })
        const identity = attribution(message.request)
        const retained = (yield* Ref.get(frames)).get(message.request.operationKey)
        if (retained !== undefined) {
          const accepted = retained.find((frame) => frame._tag === "Accepted")
          if (accepted === undefined || !sameAttribution(accepted.attribution, identity))
            return yield* HostError.make({ message: "Cell operation identity conflicts with retained execution" })
          if (
            !retained.some((frame) => frame._tag === "Terminal") &&
            !(yield* Ref.get(operations)).has(message.request.operationKey)
          ) {
            const response = {
              _tag: "DomainFailure" as const,
              failure: { kind: "unknown", message: "Cell operation outcome is unknown after executor restart" },
            }
            yield* emit(message.request.access, {
              _tag: "Terminal",
              attribution: identity,
              cursor: retained.length + 1,
              outcome: "unknown",
              response,
            })
          } else
            yield* Effect.forEach(
              retained,
              (frame) => writer(encodeExecutorMessage({ _tag: "CellLifecycle", access, frame })),
              { discard: true },
            )
          return
        }
        const accepted = { _tag: "Accepted", attribution: identity, cursor: 1 } as const
        yield* emit(message.request.access, accepted)
        const operation = Effect.gen(function* () {
          yield* emit(message.request.access, { _tag: "Started", attribution: accepted.attribution, cursor: 2 })
          const response = yield* cells
            .execute(message.request, (chunk) =>
              Effect.gen(function* () {
                const output = redactOutput(chunk.text)
                const outputFrames = (yield* Ref.get(frames)).get(message.request.operationKey) ?? []
                if (outputFrames.filter((frame) => frame._tag === "Output").length >= 16) return
                yield* emit(message.request.access, {
                  _tag: "Output",
                  attribution: accepted.attribution,
                  cursor: outputFrames.length + 1,
                  stream: chunk.stream,
                  text: output.text,
                  redacted: true,
                  truncated: output.truncated,
                }).pipe(Effect.ignore)
              }),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.succeed({
                      _tag: "DomainFailure" as const,
                      failure: { kind: "execution", message: String(cause) },
                    }),
              ),
            )
          const completedFrames = (yield* Ref.get(frames)).get(message.request.operationKey) ?? []
          yield* emit(message.request.access, {
            _tag: "Terminal",
            attribution: accepted.attribution,
            cursor: completedFrames.length + 1,
            outcome: response._tag === "Success" ? "completed" : "failed",
            response,
          })
        }).pipe(
          Effect.ensuring(
            Ref.update(operations, (values) => {
              const next = new Map(values)
              next.delete(message.request.operationKey)
              return next
            }),
          ),
        )
        const gate = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkScoped(Deferred.await(gate).pipe(Effect.andThen(operation)))
        yield* Ref.update(operations, (values) => new Map(values).set(message.request.operationKey, fiber))
        yield* Deferred.succeed(gate, undefined)
      }
      if (message._tag === "CellCancel") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        const known = (yield* Ref.get(frames)).get(message.operationKey)
        const started = known?.find((frame) => frame._tag === "Started")
        if (
          !sameAccess(access, message.access) ||
          known === undefined ||
          started === undefined ||
          started.attribution.attempt !== message.attempt
        )
          return yield* HostError.make({ message: "Cell cancellation has a stale executor fence" })
        const fiber = (yield* Ref.get(operations)).get(message.operationKey)
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        const interrupted = (yield* Ref.get(frames)).get(message.operationKey)
        if (interrupted !== undefined && !interrupted.some((frame) => frame._tag === "Terminal")) {
          const response = {
            _tag: "DomainFailure" as const,
            failure: { kind: "cancelled", message: "Cell operation cancelled" },
          }
          yield* emit(message.access, {
            _tag: "Terminal",
            attribution: started.attribution,
            cursor: interrupted.length + 1,
            outcome: "cancelled",
            response,
          })
        }
      }
      if (message._tag === "CellReplay") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        const known = (yield* Ref.get(frames)).get(message.operationKey) ?? []
        if (!sameAccess(access, message.access))
          return yield* HostError.make({ message: "Cell replay has a stale executor fence" })
        yield* Effect.forEach(
          known.filter((frame) => frame.cursor > message.afterCursor),
          (frame) => writer(encodeExecutorMessage({ _tag: "CellLifecycle", access: message.access, frame })),
          { discard: true },
        )
      }
      if (message._tag === "CellTerminalReceipt") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        const known = (yield* Ref.get(frames)).get(message.operationKey) ?? []
        const terminal = known.find(
          (frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }> =>
            frame._tag === "Terminal" &&
            frame.attribution.attempt === message.attempt &&
            frame.cursor === message.cursor,
        )
        if (terminal !== undefined && sameAccess(access, message.access))
          yield* writer(
            encodeExecutorMessage({
              _tag: "CellResult",
              access: message.access,
              operationKey: message.operationKey,
              attempt: message.attempt,
              response: terminal.response,
            }),
          )
      }
    })
    return yield* loop.pipe(Effect.forever)
  })

const connect = Effect.fn("Host.connect")(function* (
  config: Config,
  store: SessionStore,
  receipts: OperationReceiptStore,
  operations: Ref.Ref<Map<string, Fiber.Fiber<void, unknown>>>,
  frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>,
  lifecycle: Semaphore.Semaphore,
  connected: Effect.Effect<void> = Effect.void,
) {
  const runtime = yield* Runtime
  const socket = yield* Socket.makeWebSocket(config.apiUrl)
  const writer = yield* socket.writer
  const incoming = yield* Queue.make<IncomingMessage>()
  const reader = yield* socket
    .runString((frame) =>
      decodeApiMessage(frame).pipe(
        Effect.mapError(() => HostError.make({ message: "Controller sent an invalid executor frame" })),
        Effect.flatMap((message) => Queue.offer(incoming, message)),
      ),
    )
    .pipe(Effect.forkScoped)
  const opening = !(yield* runtime.hasSession)
    ? { _tag: "ExecutorHello" as const, hello: yield* runtime.hello }
    : { _tag: "ExecutorReconnect" as const, access: yield* runtime.reconnect }
  yield* writer(encodeExecutorMessage(opening))
  yield* waitForWelcome(incoming, store)
  yield* connected
  const session = yield* runtime.persistedSession
  const heartbeat = Effect.sleep(session.heartbeatIntervalMillis).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const cursor = yield* runtime.cursor
        const frame = yield* runtime.heartbeat(cursor)
        yield* writer(encodeExecutorMessage({ _tag: "ExecutorHeartbeat", heartbeat: frame }))
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  )
  yield* heartbeat
  return yield* Effect.raceFirst(
    Fiber.join(reader).pipe(
      Effect.mapError(() => HostError.make({ message: "Executor controller connection closed" })),
    ),
    consumeApi(incoming, writer, store, receipts, operations, frames, lifecycle),
  )
})

const receiveBootstrap = Effect.callback<Bootstrap, HostError>((resume) => {
  let consumed = false
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 7070,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === "/health") return new Response("ready")
      if (path !== "/.rika/bootstrap" || request.method !== "POST" || consumed)
        return new Response("not found", { status: 404 })
      return request
        .json()
        .then((input) =>
          Promise.all([
            Effect.runPromise(
              decodeBootstrap(input).pipe(
                Effect.match({
                  onFailure: () => undefined,
                  onSuccess: (value) => value,
                }),
              ),
            ),
            sandboxInstanceId(),
          ]),
        )
        .then(([body, instanceId]) => {
          if (body === undefined || instanceId.length === 0 || body.identity.instanceId !== instanceId)
            return new Response("invalid", { status: 400 })
          if (consumed) return new Response("not found", { status: 404 })
          consumed = true
          const identity: Identity = {
            ...body.identity,
            stateDirectory: Bun.env.RIKA_EXECUTOR_STATE_DIRECTORY || executorStateDirectory,
          }
          Effect.runFork(
            Effect.sleep("10 millis").pipe(
              Effect.andThen(Effect.promise(() => server.stop(true))),
              Effect.andThen(
                Effect.sync(() =>
                  resume(
                    Effect.succeed({
                      credential: Redacted.make(body.credential, { label: "executor-bootstrap" }),
                      identity,
                    }),
                  ),
                ),
              ),
            ),
          )
          return new Response("accepted", { status: 202 })
        })
        .catch(() => new Response("invalid", { status: 400 }))
    },
  })
  return Effect.promise(() => server.stop(true))
})

export const testing = { operationReceiptStore, receiveBootstrap } as const

const host = Effect.scoped(
  Effect.gen(function* () {
    const environmentIdentity = yield* executorIdentity
    const store = yield* sessionStore(environmentIdentity.stateDirectory)
    const persisted = yield* store.load
    const matchingSession =
      Option.isSome(persisted) && restores(environmentIdentity, persisted.value) ? persisted.value : undefined
    const crypto = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const statePath = Effect.fn("Host.cellStatePath")(function* (operationKey: string) {
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(operationKey))
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not identify cell state" })))
      return `${cellStateDirectory}/${Encoding.encodeHex(digest)}.json`
    })
    const readState = Effect.fn("Host.readCellState")(function* (operationKey: string) {
      const filename = yield* statePath(operationKey)
      const exists = yield* fileSystem
        .exists(filename)
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not inspect cell state" })))
      if (!exists) return undefined
      const text = yield* fileSystem
        .readFileString(filename)
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not read cell state" })))
      return yield* decodeCellState(text).pipe(
        Effect.mapError(() => CellError.make({ kind: "execution", message: "Cell state is invalid" })),
      )
    })
    const writeState = Effect.fn("Host.writeCellState")(function* (operationKey: string, state: CellStateValue) {
      const filename = yield* statePath(operationKey)
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeCellState(state).pipe(
        Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not encode cell state" })),
      )
      yield* fileSystem
        .makeDirectory(cellStateDirectory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not create cell state" })))
      yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 }).pipe(
        Effect.flatMap(() => fileSystem.rename(temporary, filename)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => CellError.make({ kind: "execution", message: "Could not persist cell state" })),
      )
    })
    const run = (
      identity: Identity,
      bootstrapToken: Redacted.Redacted<string>,
      restoredSession: SessionWire | undefined,
      connected: Effect.Effect<void> = Effect.void,
    ) =>
      Effect.gen(function* () {
        const config = yield* configuration(identity, bootstrapToken, restoredSession)
        const receipts = yield* operationReceiptStore(
          config.stateDirectory,
          config.fence.assignmentId,
          config.fence.assignmentGeneration,
        )
        const runtime = runtimeLayer({
          fence: config.fence,
          bootstrapToken: config.bootstrapToken,
          templateBuildId: config.templateBuildId,
          capabilities: { cells: true, checkpoints: false, pty: false },
          cursors: { command: 0, event: 0, pty: 0 },
          latestCheckpointId: null,
          ...(config.restoredSession === undefined ? {} : { restoredSession: config.restoredSession }),
        })
        const kernelContext = yield* Layer.build(
          kernelCellLayer({
            workspace: workspaceRoot,
            workspaceDigest: config.workspaceId,
            dataRoot: config.stateDirectory,
            runtimeVersion: process.versions.bun,
            trustMode: "trusted-local",
            servers: [],
          }).pipe(Layer.provide(BunServices.layer)),
        )
        const executor = Context.get(kernelContext, CellExecutor)
        const cells = cellsLayer({
          workspaceId: config.workspaceId,
          read: readState,
          write: writeState,
          execute: (request, output) =>
            executor.execute({
              sessionId: request.sessionId,
              cellId: request.toolCallId,
              code: request.code,
              emit: (event) =>
                event._tag === "Stdout" || event._tag === "Stderr"
                  ? output({ stream: event._tag === "Stdout" ? "stdout" : "stderr", text: event.text })
                  : Effect.void,
            }),
        })
        return yield* Effect.flatMap(
          Layer.build(Layer.merge(runtime, cells)).pipe(
            Effect.mapError((cause) => HostError.make({ message: cause.message })),
          ),
          (context) =>
            Effect.gen(function* () {
              const operations = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
              const frames = yield* Ref.make(yield* receipts.load)
              const lifecycle = yield* Semaphore.make(1)
              return yield* Effect.scoped(
                connect(config, store, receipts, operations, frames, lifecycle, connected),
              ).pipe(
                Effect.catchCause(() => Effect.sleep("1 second")),
                Effect.forever,
              )
            }).pipe(Effect.provide(context)),
        )
      })
    const monitor = (
      running: Fiber.Fiber<never, HostError>,
    ): Effect.Effect<
      never,
      HostError,
      Crypto.Crypto | FileSystem.FileSystem | Socket.WebSocketConstructor | import("effect").Scope.Scope
    > =>
      Effect.gen(function* () {
        const replacement = yield* Effect.scoped(receiveBootstrap)
        const admitted = yield* Deferred.make<void>()
        const candidate = yield* Effect.forkScoped(
          run(
            replacement.identity,
            replacement.credential,
            undefined,
            Deferred.succeed(admitted, undefined).pipe(Effect.asVoid),
          ),
        )
        const accepted = yield* Deferred.await(admitted).pipe(Effect.timeoutOption("30 seconds"))
        if (Option.isNone(accepted)) {
          yield* Fiber.interrupt(candidate)
          return yield* monitor(running)
        }
        yield* Fiber.interrupt(running)
        return yield* monitor(candidate)
      })
    const supervise = (
      identity: Identity,
      bootstrapToken: Redacted.Redacted<string>,
      restoredSession: SessionWire | undefined,
    ): Effect.Effect<
      never,
      HostError,
      Crypto.Crypto | FileSystem.FileSystem | Socket.WebSocketConstructor | import("effect").Scope.Scope
    > =>
      Effect.gen(function* () {
        const running = yield* Effect.forkScoped(run(identity, bootstrapToken, restoredSession))
        return yield* monitor(running)
      })
    if (matchingSession === undefined) {
      const bootstrap = yield* Effect.scoped(receiveBootstrap)
      return yield* supervise(bootstrap.identity, bootstrap.credential, undefined)
    }
    const selected = yield* Deferred.make<"bootstrap" | "reconnect">()
    const fresh = yield* Effect.forkScoped(
      Effect.scoped(receiveBootstrap).pipe(
        Effect.flatMap((bootstrap) =>
          run(
            bootstrap.identity,
            bootstrap.credential,
            undefined,
            Deferred.succeed(selected, "bootstrap").pipe(Effect.asVoid),
          ),
        ),
      ),
    )
    const restored = yield* Effect.forkScoped(
      run(
        environmentIdentity,
        Redacted.make("", { label: "executor-bootstrap-not-required" }),
        matchingSession,
        Deferred.succeed(selected, "reconnect").pipe(Effect.asVoid),
      ),
    )
    const winner = yield* Deferred.await(selected)
    const running = winner === "bootstrap" ? fresh : restored
    yield* Fiber.interrupt(winner === "bootstrap" ? restored : fresh)
    return yield* monitor(running)
  }),
)

const program: Effect.Effect<void, HostError> = Effect.scoped(
  Effect.flatMap(
    Layer.build(Layer.mergeAll(BunSocket.layerWebSocketConstructor, BunCrypto.layer, BunFileSystem.layer)),
    (context) => Effect.provide(host, context),
  ),
)

if (import.meta.main) BunRuntime.runMain(program)
