import { BunFileSystem } from "@effect/platform-bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { Crypto, Effect, Encoding, Fiber, FileSystem, Layer, Queue, Redacted, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { CellError, Cells, State as CellState, layer as cellsLayer, type State as CellStateValue } from "./cells"
import { Runtime, layer as runtimeLayer } from "./runtime"
import {
  ControllerMessage,
  type ControllerMessage as IncomingMessage,
  type Fence,
  HostMessage,
  Target,
} from "./protocol"

interface Config {
  readonly fence: Fence
  readonly templateBuildId: string | null
  readonly controllerUrl: string
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly workspace: string
}

class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
}) {}

const decodeControllerMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ControllerMessage))
const encodeHostMessage = Schema.encodeSync(Schema.fromJsonString(HostMessage))
const decodeCellState = Schema.decodeUnknownEffect(Schema.fromJsonString(CellState))
const encodeCellState = Schema.encodeEffect(Schema.fromJsonString(CellState))
const cellStateDirectory = "/var/lib/rika-executor/cells"
const maximumOutputLength = 1_000_000

const required = (name: string) => {
  const value = Bun.env[name]
  return value === undefined || value.length === 0
    ? Effect.fail(HostError.make({ message: `${name} is required` }))
    : Effect.succeed(value)
}

const target = Effect.flatMap(required("RIKA_EXECUTOR_TARGET"), (value) =>
  Schema.decodeUnknownEffect(Target)(value).pipe(
    Effect.mapError(() => HostError.make({ message: "RIKA_EXECUTOR_TARGET is invalid" })),
  ),
)

const configuration = (bootstrapToken: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const assignmentId = yield* required("RIKA_EXECUTOR_ASSIGNMENT_ID")
    const generationText = yield* required("RIKA_EXECUTOR_GENERATION")
    const generation = Number(generationText)
    if (!Number.isSafeInteger(generation) || generation < 1)
      return yield* HostError.make({ message: "RIKA_EXECUTOR_GENERATION is invalid" })
    const executorTarget: Target = yield* target
    const instanceId =
      executorTarget === "e2b" ? yield* required("E2B_SANDBOX_ID") : yield* required("RIKA_EXECUTOR_INSTANCE_ID")
    const crypto = yield* Crypto.Crypto
    const processIncarnation = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => HostError.make({ message: "Could not create the process incarnation" })),
    )
    return {
      fence: {
        target: executorTarget,
        assignmentId,
        assignmentGeneration: generation,
        instanceId,
        executorId: `${yield* required("RIKA_EXECUTOR_ID")}:${processIncarnation}`,
        processIncarnation,
      },
      templateBuildId: executorTarget === "e2b" ? yield* required("RIKA_EXECUTOR_TEMPLATE_BUILD_ID") : null,
      controllerUrl: yield* required("RIKA_EXECUTOR_CONTROLLER_URL"),
      bootstrapToken,
      workspace: yield* required("RIKA_EXECUTOR_WORKSPACE"),
    } satisfies Config
  })

const waitForWelcome = (
  config: Config,
  incoming: Queue.Queue<IncomingMessage>,
): Effect.Effect<void, HostError, Runtime> =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
    if (message._tag === "ExecutorWelcome") {
      yield* runtime
        .welcome(message.welcome)
        .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
      return
    }
    if (message._tag === "ExecutorReconnected") {
      yield* runtime
        .reconnected(message.welcome)
        .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
      return
    }
    return yield* waitForWelcome(config, incoming)
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

const consumeController = (
  incoming: Queue.Queue<IncomingMessage>,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
) =>
  Effect.gen(function* () {
    const runtime = yield* Runtime
    const cells = yield* Cells
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* HostError.make({ message: message.message })
    if (message._tag === "LeaseReceipt") {
      yield* runtime
        .receipt(message.receipt)
        .pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
    }
    if (message._tag === "CellExecute") {
      const access = yield* runtime.access.pipe(Effect.mapError((cause) => HostError.make({ message: cause.message })))
      const response = sameAccess(access, message.request.access)
        ? yield* cells
            .execute(message.request)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.succeed({ _tag: "DomainFailure" as const, failure: { kind: "fenced", message: String(cause) } }),
              ),
            )
        : {
            _tag: "DomainFailure" as const,
            failure: { kind: "fenced", message: "Cell request has a stale executor fence" },
          }
      yield* writer(encodeHostMessage({ _tag: "CellResult", operationKey: message.request.operationKey, response }))
    }
  }).pipe(Effect.forever)

const connect = Effect.fn("Host.connect")(function* (config: Config) {
  const runtime = yield* Runtime
  const socket = yield* Socket.makeWebSocket(config.controllerUrl)
  const writer = yield* socket.writer
  const incoming = yield* Queue.make<IncomingMessage>()
  const reader = yield* socket
    .runString((frame) =>
      decodeControllerMessage(frame).pipe(
        Effect.mapError(() => HostError.make({ message: "Controller sent an invalid executor frame" })),
        Effect.flatMap((message) => Queue.offer(incoming, message)),
      ),
    )
    .pipe(Effect.forkScoped)
  const opening = !(yield* runtime.hasSession)
    ? { _tag: "ExecutorHello" as const, hello: yield* runtime.hello }
    : { _tag: "ExecutorReconnect" as const, access: yield* runtime.reconnect }
  yield* writer(encodeHostMessage(opening))
  yield* waitForWelcome(config, incoming)
  const session = yield* runtime.persistedSession
  const heartbeat = Effect.sleep(session.heartbeatIntervalMillis).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const cursor = yield* runtime.cursor
        const frame = yield* runtime.heartbeat(cursor)
        yield* writer(encodeHostMessage({ _tag: "ExecutorHeartbeat", heartbeat: frame }))
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
    consumeController(incoming, writer),
  )
})

const receiveBootstrap = Effect.callback<Redacted.Redacted<string>, HostError>((resume) => {
  let consumed = false
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 7070,
    fetch: (request) => {
      const path = new URL(request.url).pathname
      if (path === "/health") return new Response("ready")
      if (path !== "/.rika/bootstrap" || request.method !== "POST" || consumed)
        return new Response("not found", { status: 404 })
      return request.json().then((input) => {
        const body = input as { readonly credential?: unknown }
        if (typeof body.credential !== "string" || body.credential.length === 0)
          return new Response("invalid", { status: 400 })
        consumed = true
        resume(Effect.succeed(Redacted.make(body.credential, { label: "executor-bootstrap" })))
        return new Response("accepted", { status: 202 })
      })
    },
  })
  return Effect.promise(() => server.stop(true))
})

const executeCell = (workspace: string, code: string) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () =>
        Bun.spawn(["sudo", "-n", "-u", "rika-workspace", "--", "/bin/sh", "-lc", code], {
          cwd: workspace,
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: () => CellError.make({ kind: "execution", message: "Could not start cell" }),
    }),
    (process) =>
      Effect.tryPromise({
        try: () =>
          Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]).then(
            ([exitCode, stdout, stderr]) => {
              const result = {
                exitCode,
                stdout: stdout.slice(0, maximumOutputLength),
                stderr: stderr.slice(0, maximumOutputLength),
                truncated: stdout.length > maximumOutputLength || stderr.length > maximumOutputLength,
              }
              return exitCode === 0
                ? { _tag: "Success" as const, result }
                : { _tag: "DomainFailure" as const, failure: result }
            },
          ),
        catch: () => CellError.make({ kind: "execution", message: "Cell process failed" }),
      }),
    (process) => Effect.sync(() => process.kill()).pipe(Effect.ignore),
  )

const host = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* configuration(yield* receiveBootstrap)
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
    const runtime = runtimeLayer({
      fence: config.fence,
      bootstrapToken: config.bootstrapToken,
      templateBuildId: config.templateBuildId,
      capabilities: { cells: true, checkpoints: true, pty: true },
      cursors: { command: 0, event: 0, pty: 0 },
      latestCheckpointId: null,
    })
    const cells = cellsLayer({
      workspace: config.workspace,
      read: readState,
      write: writeState,
      execute: (request) => executeCell(config.workspace, request.code),
    })
    return yield* Effect.flatMap(
      Layer.build(Layer.merge(runtime, cells)).pipe(
        Effect.mapError((cause) => HostError.make({ message: cause.message })),
      ),
      (context) =>
        Effect.scoped(connect(config)).pipe(
          Effect.catchCause(() => Effect.sleep("1 second")),
          Effect.forever,
          Effect.provide(context),
        ),
    )
  }),
)

const program: Effect.Effect<void, HostError> = Effect.scoped(
  Effect.flatMap(
    Layer.build(Layer.mergeAll(BunSocket.layerWebSocketConstructor, BunCrypto.layer, BunFileSystem.layer)),
    (context) => Effect.provide(host, context),
  ),
)

BunRuntime.runMain(program)
