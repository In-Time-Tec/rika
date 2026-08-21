import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
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
  Path,
  Queue,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { BindingProxyError } from "./binding-proxy"
import { CellError, State as CellState, type State as CellStateValue } from "./cells"
import * as HostedKernel from "./hosted-kernel"
import {
  Machine,
  MachineError,
  State as MachineState,
  workspaceLayer as machineLayer,
  type State as MachineStateValue,
} from "./machine"
import {
  Manager as PtyManager,
  driverLayer as ptyDriverLayer,
  layer as ptyLayer,
  liveCapabilities,
  repositoryLayer as ptyRepositoryLayer,
  type Connection as PtyConnection,
} from "./pty"
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
const decodeMachineState = Schema.decodeUnknownEffect(Schema.fromJsonString(MachineState))
const encodeMachineState = Schema.encodeEffect(Schema.fromJsonString(MachineState))
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
const directoryMode = 0o700
const fileMode = 0o600
const sandboxIdPath = "/run/e2b/.E2B_SANDBOX_ID"
const workspaceRoot = Bun.env.RIKA_EXECUTOR_WORKSPACE_ROOT || "/workspace"
const workspaceUser = "rika-workspace"

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
    const assignmentDigest = yield* crypto.digest("SHA-256", new TextEncoder().encode(assignmentId)).pipe(Effect.orDie)
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

const sameFence = (left: Fence, right: Fence) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.assignmentGeneration === right.assignmentGeneration &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId &&
  left.processIncarnation === right.processIncarnation

const sameAccess = (
  left: { readonly fence: Fence; readonly leaseEpoch: number; readonly sessionToken: string },
  right: typeof left,
) =>
  left.leaseEpoch === right.leaseEpoch && left.sessionToken === right.sessionToken && sameFence(left.fence, right.fence)

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

const ptyCreate = (connection: PtyConnection) => ({
  ptyId: connection.ptyId,
  command: connection.command,
  cwd: connection.cwd,
  cols: connection.cols,
  rows: connection.rows,
})

const dispatchPty = Effect.fn("Host.dispatchPty")(function* (
  message: IncomingMessage,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  delivery: Semaphore.Semaphore,
) {
  if (
    message._tag !== "PtyCreate" &&
    message._tag !== "PtyInput" &&
    message._tag !== "PtyResize" &&
    message._tag !== "PtyDisconnect" &&
    message._tag !== "PtyReconnect" &&
    message._tag !== "PtyTerminate"
  )
    return false
  const runtime = yield* Runtime
  const pty = yield* PtyManager
  const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
  if (!sameFence(access.fence, message.fence))
    return yield* HostError.make({ message: "PTY request has a stale executor fence" })
  const write = (outgoing: Parameters<typeof encodeExecutorMessage>[0]) =>
    writer(encodeExecutorMessage(outgoing)).pipe(
      Effect.mapError(() => HostError.make({ message: "Could not write PTY frame" })),
    )
  yield* delivery.withPermits(1)(
    Effect.gen(function* () {
      if (message._tag === "PtyCreate") {
        const opened = yield* pty.create(message.request)
        yield* write(
          opened.terminated
            ? { _tag: "PtyTerminated", access, ptyId: opened.ptyId, cursor: opened.cursor }
            : { _tag: "PtyOpened", access, pty: ptyCreate(opened) },
        )
        return
      }
      if (message._tag === "PtyInput") {
        yield* pty.input(message.request)
        return
      }
      if (message._tag === "PtyResize") {
        const resized = yield* pty.resize(message.request)
        yield* write({ _tag: "PtyOpened", access, pty: ptyCreate(resized) })
        return
      }
      if (message._tag === "PtyDisconnect") {
        const disconnected = yield* pty.disconnect(message.ptyId)
        yield* write({ _tag: "PtyDisconnected", access, ptyId: disconnected.ptyId, cursor: disconnected.cursor })
        return
      }
      if (message._tag === "PtyReconnect") {
        const reconnected = yield* pty.reconnect(message.request)
        yield* write({ _tag: "PtyOpened", access, pty: ptyCreate(reconnected) })
        if (reconnected.gap !== null)
          yield* write({ _tag: "PtyReplayGap", access, ptyId: reconnected.ptyId, gap: reconnected.gap })
        yield* Effect.forEach(
          reconnected.transcript,
          (chunk) => write({ _tag: "PtyOutput", access, ptyId: reconnected.ptyId, chunk }),
          { discard: true },
        )
        return
      }
      const terminated = yield* pty.terminate(message.ptyId)
      yield* write({ _tag: "PtyTerminated", access, ptyId: terminated.ptyId, cursor: terminated.cursor })
    }).pipe(Effect.mapError((cause) => HostError.make({ message: cause.message }))),
  )
  return true
})

const consumePtyEvents = (
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  delivery: Semaphore.Semaphore,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const pty = yield* PtyManager
    yield* pty.events.pipe(
      Stream.runForEach((event) =>
        delivery.withPermits(1)(
          Effect.gen(function* () {
            const access = yield* runtime.access
            const outgoing =
              event._tag === "Output"
                ? { _tag: "PtyOutput" as const, access, ptyId: event.ptyId, chunk: event.chunk }
                : { _tag: "PtyTerminated" as const, access, ptyId: event.ptyId, cursor: event.cursor }
            yield* writer(encodeExecutorMessage(outgoing))
          }),
        ),
      ),
      Effect.mapError((cause) => HostError.make({ message: cause.message })),
    )
  })

const consumeApi = (
  incoming: Queue.Queue<IncomingMessage>,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  store: SessionStore,
  receipts: OperationReceiptStore,
  operations: Ref.Ref<Map<string, Fiber.Fiber<void, unknown>>>,
  frames: Ref.Ref<Map<string, ReadonlyArray<CellLifecycleFrame>>>,
  lifecycle: Semaphore.Semaphore,
  cells: HostedKernel.Interface,
  machine: Machine["Service"],
  ptyDelivery: Semaphore.Semaphore,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
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
      if (message._tag === "BindingResult") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (!sameAccess(access, message.access))
          return yield* HostError.make({ message: "Binding result has a stale executor fence" })
        yield* cells
          .completeBinding(message)
          .pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
      }
      if (message._tag === "MachineExecute") {
        const access = yield* runtime.access.pipe(
          Effect.mapError((cause) => HostError.make({ message: cause.message })),
        )
        if (!sameAccess(access, message.access))
          return yield* HostError.make({ message: "Machine request has a stale executor fence" })
        yield* machine
          .execute({
            machineId: message.machineId,
            requestDigest: message.requestDigest,
            request: message.request,
          })
          .pipe(
            Effect.flatMap((outcome) =>
              writer(
                encodeExecutorMessage({
                  _tag: "MachineResult",
                  access: message.access,
                  operationKey: message.operationKey,
                  attempt: message.attempt,
                  machineId: message.machineId,
                  requestDigest: message.requestDigest,
                  outcome,
                }),
              ),
            ),
            Effect.mapError((error) => HostError.make({ message: error.message })),
            Effect.forkScoped,
          )
      }
      if (yield* dispatchPty(message, writer, ptyDelivery)) return
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
  cells: HostedKernel.Interface,
  machine: Machine["Service"],
  ptyDelivery: Semaphore.Semaphore,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  connected: Effect.Effect<void> = Effect.void,
) {
  const runtime = yield* Runtime
  const socket = yield* Socket.makeWebSocket(config.apiUrl)
  const writer = yield* socket.writer
  yield* Ref.set(activeWriter, writer)
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
  yield* runtime.access.pipe(
    Effect.flatMap(cells.replayBindings),
    Effect.mapError((error) => HostError.make({ message: error.message })),
  )
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
  const connectedSession = Effect.raceFirst(
    Effect.raceFirst(
      Fiber.join(reader).pipe(
        Effect.mapError(() => HostError.make({ message: "Executor controller connection closed" })),
      ),
      consumeApi(incoming, writer, store, receipts, operations, frames, lifecycle, cells, machine, ptyDelivery),
    ),
    consumePtyEvents(writer, ptyDelivery),
  )
  const pty = yield* PtyManager
  return yield* connectedSession.pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* pty.disconnectAll.pipe(Effect.ignore)
        const running = yield* Ref.getAndSet(operations, new Map())
        yield* Effect.forEach(running.values(), Fiber.interrupt, { discard: true })
        yield* Ref.set(activeWriter, undefined)
      }),
    ),
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

export const testing = { dispatchPty, operationReceiptStore, receiveBootstrap, sameFence } as const

const host = Effect.scoped(
  Effect.gen(function* () {
    const environmentIdentity = yield* executorIdentity
    const cellStateDirectory = `${environmentIdentity.stateDirectory}/cells`
    const machineStateDirectory = `${environmentIdentity.stateDirectory}/machines`
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
    const machinePath = Effect.fn("Host.machineStatePath")(function* (machineId: string) {
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(machineId))
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not identify machine state" })))
      return `${machineStateDirectory}/${Encoding.encodeHex(digest)}.json`
    })
    const readMachine = Effect.fn("Host.readMachineState")(function* (machineId: string) {
      const filename = yield* machinePath(machineId)
      const exists = yield* fileSystem
        .exists(filename)
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not inspect machine state" })))
      if (!exists) return undefined
      const text = yield* fileSystem
        .readFileString(filename)
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not read machine state" })))
      return yield* decodeMachineState(text).pipe(
        Effect.mapError(() => MachineError.make({ message: "Machine state is invalid" })),
      )
    })
    const writeMachine = Effect.fn("Host.writeMachineState")(function* (machineId: string, state: MachineStateValue) {
      const filename = yield* machinePath(machineId)
      const temporary = `${filename}.tmp-${process.pid}`
      const text = yield* encodeMachineState(state).pipe(
        Effect.mapError(() => MachineError.make({ message: "Could not encode machine state" })),
      )
      yield* fileSystem
        .makeDirectory(machineStateDirectory, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError(() => MachineError.make({ message: "Could not create machine state" })))
      yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 }).pipe(
        Effect.flatMap(() => fileSystem.rename(temporary, filename)),
        Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)),
        Effect.mapError(() => MachineError.make({ message: "Could not persist machine state" })),
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
        const ptyContext = yield* Layer.build(
          ptyLayer.pipe(
            Layer.provide(
              Layer.merge(
                ptyDriverLayer({
                  fence: config.fence,
                  workspaceRoot,
                  workspaceUser,
                }),
                ptyRepositoryLayer({
                  stateDirectory: config.stateDirectory,
                  fence: config.fence,
                }),
              ),
            ),
          ),
        ).pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
        const capabilities = yield* liveCapabilities(workspaceUser)
        const pty = Context.get(ptyContext, PtyManager)
        yield* pty.disconnectAll.pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
        const ptyCursor = yield* pty.cursor.pipe(Effect.mapError((error) => HostError.make({ message: error.message })))
        const runtime = runtimeLayer({
          fence: config.fence,
          bootstrapToken: config.bootstrapToken,
          templateBuildId: config.templateBuildId,
          capabilities: { ...capabilities, pty: config.fence.target === "e2b" && capabilities.pty },
          cursors: { command: 0, event: 0, pty: ptyCursor },
          latestCheckpointId: null,
          ...(config.restoredSession === undefined ? {} : { restoredSession: config.restoredSession }),
        })
        const runtimeContext = yield* Layer.build(runtime).pipe(
          Effect.mapError((error) => HostError.make({ message: error.message })),
        )
        const executorRuntime = Context.get(runtimeContext, Runtime)
        const activeWriter = yield* Ref.make<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>(
          undefined,
        )
        const cells = yield* HostedKernel.make({
          workspaceIdentity: config.workspaceId,
          workspacePath: workspaceRoot,
          dataRoot: config.stateDirectory,
          read: readState,
          write: writeState,
          sendBinding: (message) =>
            Effect.gen(function* () {
              const writer = yield* Ref.get(activeWriter)
              if (writer === undefined)
                return yield* BindingProxyError.make({ message: "Executor binding transport is unavailable" })
              const currentAccess = yield* executorRuntime.access.pipe(
                Effect.mapError(() => BindingProxyError.make({ message: "Executor binding access is unavailable" })),
              )
              yield* writer(encodeExecutorMessage({ _tag: "BindingInvoke", ...message, access: currentAccess })).pipe(
                Effect.mapError(() => BindingProxyError.make({ message: "Could not write executor binding request" })),
              )
            }),
        })
        const machineContext = yield* Layer.build(
          machineLayer({ workspace: workspaceRoot, read: readMachine, write: writeMachine }),
        )
        const machine = Context.get(machineContext, Machine)
        const operations = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
        const frames = yield* Ref.make(yield* receipts.load)
        const lifecycle = yield* Semaphore.make(1)
        const ptyDelivery = yield* Semaphore.make(1)
        return yield* Effect.scoped(
          connect(
            config,
            store,
            receipts,
            operations,
            frames,
            lifecycle,
            cells,
            machine,
            ptyDelivery,
            activeWriter,
            connected,
          ),
        ).pipe(
          Effect.provide(Context.merge(runtimeContext, ptyContext)),
          Effect.catchCause(() => Effect.sleep("1 second")),
          Effect.forever,
        )
      })
    const monitor = (
      running: Fiber.Fiber<never, HostError>,
    ): Effect.Effect<
      never,
      HostError,
      | ChildProcessSpawner.ChildProcessSpawner
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | Socket.WebSocketConstructor
      | import("effect").Scope.Scope
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
      | ChildProcessSpawner.ChildProcessSpawner
      | Crypto.Crypto
      | FileSystem.FileSystem
      | Path.Path
      | Socket.WebSocketConstructor
      | import("effect").Scope.Scope
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
  Effect.flatMap(Layer.build(Layer.merge(BunSocket.layerWebSocketConstructor, BunServices.layer)), (context) =>
    Effect.provide(host, context),
  ),
)

if (import.meta.main) BunRuntime.runMain(program)
