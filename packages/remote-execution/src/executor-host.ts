import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Effect, Fiber, Layer, Queue, Redacted, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { ExecutorRuntime, layer as executorRuntimeLayer } from "./executor-runtime"
import {
  ExecutorControllerMessage,
  ExecutorHostMessage,
  ExecutorSessionWire,
  ExecutorTarget,
  type ExecutorControllerMessage as IncomingMessage,
  type ExecutorFence,
  type ExecutorSessionWire as PersistedSession,
  type ExecutorTarget as Target,
} from "./protocol"

interface HostConfiguration {
  readonly fence: ExecutorFence
  readonly controllerUrl: string
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly sessionPath: string
  readonly restoredSession?: PersistedSession
}

class ExecutorHostError extends Schema.TaggedError<ExecutorHostError>()("ExecutorHostError", {
  message: Schema.String,
}) {}

const decodeControllerMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutorControllerMessage))
const encodeHostMessage = Schema.encodeSync(Schema.fromJsonString(ExecutorHostMessage))
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutorSessionWire))
const encodeSession = Schema.encodeSync(Schema.fromJsonString(ExecutorSessionWire))

const required = (name: string) => {
  const value = Bun.env[name]
  return value === undefined || value.length === 0
    ? Effect.fail(ExecutorHostError.make({ message: `${name} is required` }))
    : Effect.succeed(value)
}

const target = Effect.flatMap(required("RIKA_EXECUTOR_TARGET"), (value) =>
  Schema.decodeUnknownEffect(ExecutorTarget)(value).pipe(
    Effect.mapError(() => ExecutorHostError.make({ message: "RIKA_EXECUTOR_TARGET is invalid" })),
  ),
)

const loadSession = (path: string) =>
  Effect.gen(function* () {
    const file = Bun.file(path)
    if (!(yield* Effect.promise(() => file.exists()))) return undefined
    const content = yield* Effect.promise(() => file.text())
    return yield* decodeSession(content).pipe(
      Effect.mapError(() => ExecutorHostError.make({ message: "Persisted executor session is invalid" })),
    )
  })

const configuration = Effect.gen(function* () {
  const assignmentId = yield* required("RIKA_EXECUTOR_ASSIGNMENT_ID")
  const generationText = yield* required("RIKA_EXECUTOR_GENERATION")
  const generation = Number(generationText)
  if (!Number.isSafeInteger(generation) || generation < 1)
    return yield* ExecutorHostError.make({ message: "RIKA_EXECUTOR_GENERATION is invalid" })
  const executorTarget: Target = yield* target
  const instanceId = yield* required("RIKA_EXECUTOR_INSTANCE_ID")
  const sessionPath = Bun.env.RIKA_EXECUTOR_SESSION_PATH ?? "/var/lib/rika-executor/session-v1.json"
  const restoredSession = yield* loadSession(sessionPath)
  return {
    fence: {
      target: executorTarget,
      assignmentId,
      generation,
      instanceId,
      executorId: yield* required("RIKA_EXECUTOR_ID"),
    },
    controllerUrl: yield* required("RIKA_EXECUTOR_CONTROLLER_URL"),
    bootstrapToken: Redacted.make(yield* required("RIKA_EXECUTOR_BOOTSTRAP_TOKEN"), {
      label: "executor-bootstrap",
    }),
    sessionPath,
    ...(restoredSession === undefined ? {} : { restoredSession }),
  } satisfies HostConfiguration
})

const persistSession = (path: string) =>
  Effect.gen(function* () {
    const runtime = yield* ExecutorRuntime
    const session = yield* runtime.persistedSession.pipe(
      Effect.mapError((cause) => ExecutorHostError.make({ message: cause.message })),
    )
    yield* Effect.tryPromise({
      try: () => Bun.write(path, encodeSession(session)),
      catch: () => ExecutorHostError.make({ message: "Executor session could not be persisted" }),
    })
  })

const waitForWelcome = (
  config: HostConfiguration,
  incoming: Queue.Queue<IncomingMessage>,
): Effect.Effect<void, ExecutorHostError, ExecutorRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* ExecutorRuntime
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* ExecutorHostError.make({ message: message.message })
    if (message._tag === "ExecutorWelcome") {
      yield* runtime
        .welcome(message.welcome)
        .pipe(Effect.mapError((cause) => ExecutorHostError.make({ message: cause.message })))
      return yield* persistSession(config.sessionPath)
    }
    if (message._tag === "ExecutorReconnected") {
      yield* runtime
        .reconnected(message.welcome)
        .pipe(Effect.mapError((cause) => ExecutorHostError.make({ message: cause.message })))
      return yield* persistSession(config.sessionPath)
    }
    return yield* waitForWelcome(config, incoming)
  })

const consumeController = (config: HostConfiguration, incoming: Queue.Queue<IncomingMessage>) =>
  Effect.gen(function* () {
    const runtime = yield* ExecutorRuntime
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* ExecutorHostError.make({ message: message.message })
    if (message._tag === "LeaseReceipt") {
      yield* runtime
        .receipt(message.receipt)
        .pipe(Effect.mapError((cause) => ExecutorHostError.make({ message: cause.message })))
      yield* persistSession(config.sessionPath)
    }
  }).pipe(Effect.forever)

const connect = Effect.fn("ExecutorHost.connect")(function* (config: HostConfiguration) {
  const runtime = yield* ExecutorRuntime
  const socket = yield* Socket.makeWebSocket(config.controllerUrl)
  const writer = yield* socket.writer
  const incoming = yield* Queue.make<IncomingMessage>()
  const reader = yield* socket
    .runString((frame) =>
      decodeControllerMessage(frame).pipe(
        Effect.mapError(() => ExecutorHostError.make({ message: "Controller sent an invalid executor frame" })),
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
      Effect.mapError(() => ExecutorHostError.make({ message: "Executor controller connection closed" })),
    ),
    consumeController(config, incoming),
  )
})

const healthServer = Effect.acquireRelease(
  Effect.sync(() =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 7070,
      fetch: (request) =>
        new URL(request.url).pathname === "/health"
          ? new Response("ready", { status: 200 })
          : new Response("not found", { status: 404 }),
    }),
  ),
  (server) => Effect.promise(() => server.stop(true)),
)

const host = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* configuration
    yield* healthServer
    const runtime = executorRuntimeLayer({
      fence: config.fence,
      bootstrapToken: config.bootstrapToken,
      ...(config.restoredSession === undefined ? {} : { restoredSession: config.restoredSession }),
    })
    return yield* Effect.flatMap(
      Layer.build(runtime).pipe(Effect.mapError((cause) => ExecutorHostError.make({ message: cause.message }))),
      (context) =>
        Effect.scoped(connect(config)).pipe(
          Effect.catchCause(() => Effect.sleep("1 second")),
          Effect.forever,
          Effect.provide(context),
        ),
    )
  }),
)

const program: Effect.Effect<void, ExecutorHostError> = Effect.scoped(
  Effect.flatMap(Layer.build(BunSocket.layerWebSocketConstructor), (context) => Effect.provide(host, context)),
)

BunRuntime.runMain(program)
