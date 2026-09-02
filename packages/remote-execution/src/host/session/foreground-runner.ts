import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { BunFileSystem } from "@effect/platform-bun"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
import {
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as Operations from "../../protocol/operations"
import { consumeFailureKind, messageCorrelation, runnerEvent, runnerWarning } from "../../protocol/telemetry"
import { NativeToolError, NativeToolService, nativeToolLayer } from "../machinery/native-tool"
import {
  ApiMessage,
  type ApiMessage as IncomingMessage,
  RunnerMessage,
  type ResumeCursors,
} from "../../protocol/messages"
import { inspectWorkspaceCapabilities } from "../../workspace/capabilities"
import type { ForegroundRunnerOptions, ForegroundRunnerSnapshot } from "./foreground-contract"
import { ForegroundRunnerError } from "./foreground-contract"
import { ForegroundSession, type LocalSession } from "./foreground-session"

export * from "./foreground-contract"

const { access, applyLeaseReceipt, failure, initialSessionFor, runnerUrl, waitForReconnect, waitForWelcome } =
  ForegroundSession

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const encodeRunnerMessage = Schema.encodeSync(Schema.fromJsonString(RunnerMessage))
const localCapabilities = { nativeTools: true, checkpoints: false, pty: false } as const
const initialCursors: ResumeCursors = { command: 0, event: 0, pty: 0 }

const isOperationMessage = (message: IncomingMessage): message is Parameters<Operations.Interface["dispatch"]>[0] =>
  message._tag === "MachineExecute" || message._tag === "MachineCancel"

const consumeApi = (
  incoming: Queue.Queue<IncomingMessage>,
  session: Ref.Ref<LocalSession | undefined>,
  operations: Operations.Interface,
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
) =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    yield* runnerEvent("runner.message.received", messageCorrelation(message))
    if (message._tag === "Fenced") {
      yield* runnerWarning("runner.fenced", messageCorrelation(message))
      return yield* failure(message.message)
    }
    if (message._tag === "LeaseReceipt") yield* applyLeaseReceipt(message, session, persist)
    if (isOperationMessage(message))
      yield* operations.dispatch(message).pipe(Effect.mapError((error) => failure(error.message)))
  }).pipe(
    Effect.forever,
    Effect.tapError((error) =>
      runnerWarning("runner.consume.failed", { "rika.outcome": consumeFailureKind(error.message) }),
    ),
  )

const connected = (
  options: ForegroundRunnerOptions,
  url: string,
  processIncarnation: string,
  workspaceCapabilities: WorkspaceCapabilitySnapshot,
  sessions: Ref.Ref<LocalSession | undefined>,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  operations: Operations.Interface,
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const previous = yield* Ref.get(sessions)
      const socket = yield* Socket.makeWebSocket(url)
      const writer = yield* socket.writer
      const incoming = yield* Queue.make<IncomingMessage>()
      const handshakeResult = yield* Deferred.make<void, ForegroundRunnerError>()
      const handshake =
        previous === undefined
          ? Effect.gen(function* () {
              const admission = options.admission
              if (admission === undefined) return yield* failure("Runner admission is unavailable")
              yield* writer(
                encodeRunnerMessage({
                  _tag: "RunnerHello",
                  hello: {
                    protocolVersion: runnerProtocolVersion,
                    admissionId: admission.admissionId,
                    ticket: admission.ticket,
                    processIncarnation,
                    capabilities: localCapabilities,
                    workspaceCapabilities,
                    cursors: initialCursors,
                  },
                }),
              ).pipe(Effect.mapError(() => failure("Could not write Runner hello")))
            })
          : writer(
              encodeRunnerMessage({
                _tag: "ExecutorReconnect",
                protocolVersion: runnerProtocolVersion,
                access: access(previous),
              }),
            ).pipe(Effect.mapError(() => failure("Could not write Runner reconnect")))
      const onOpen = handshake.pipe(
        Effect.matchEffect({
          onFailure: (error) => Deferred.fail(handshakeResult, error),
          onSuccess: () => Deferred.succeed(handshakeResult, undefined),
        }),
        Effect.asVoid,
      )
      const reader = yield* socket
        .runString(
          (frame) =>
            decodeApiMessage(frame).pipe(
              Effect.mapError(() => failure("Controller sent an invalid Runner frame")),
              Effect.flatMap((message) => Queue.offer(incoming, message)),
            ),
          { onOpen },
        )
        .pipe(Effect.forkScoped)
      const session =
        previous === undefined
          ? yield* Effect.raceFirst(
              Deferred.await(handshakeResult).pipe(Effect.andThen(waitForWelcome(incoming, processIncarnation))),
              Fiber.join(reader).pipe(
                Effect.flatMap(() => failure("Runner controller connection closed before welcome")),
                Effect.catch(() => failure("Runner controller connection failed before welcome")),
              ),
            ).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => failure("Runner controller did not welcome the executor"),
              }),
            )
          : yield* Effect.raceFirst(
              Deferred.await(handshakeResult).pipe(
                Effect.andThen(waitForReconnect(incoming, previous, processIncarnation)),
              ),
              Fiber.join(reader).pipe(
                Effect.flatMap(() => failure("Runner controller connection closed before reconnect")),
                Effect.catch(() => failure("Runner controller connection failed before reconnect")),
              ),
            ).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => failure("Runner controller did not accept the reconnect"),
              }),
            )
      yield* Ref.set(sessions, session)
      yield* Ref.set(activeWriter, writer)
      yield* runnerEvent(previous === undefined ? "runner.socket.welcome" : "runner.socket.reconnected", {})
      yield* persist()
      if (options.ready !== undefined) yield* Deferred.succeed(options.ready, undefined)
      const heartbeat = Effect.sleep(session.heartbeatIntervalMillis).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const current = yield* Ref.get(sessions)
            if (current === undefined) return
            yield* writer(
              encodeRunnerMessage({
                _tag: "ExecutorHeartbeat",
                heartbeat: { version: 1, access: access(current), cursor: current.cursor },
              }),
            ).pipe(
              Effect.tapError(() => runnerWarning("runner.heartbeat.failed", {})),
              Effect.mapError(() => failure("Could not write Runner heartbeat")),
            )
          }),
        ),
        Effect.forever,
      )
      const leaseWatchdog = Effect.gen(function* () {
        const current = yield* Ref.get(sessions)
        if (current === undefined) return yield* failure("Runner session is unavailable")
        const now = yield* Clock.currentTimeMillis
        const delay = current.leaseExpiresAt - current.heartbeatIntervalMillis - now
        if (delay <= 0) return yield* failure("Runner controller stopped renewing the executor lease")
        yield* Effect.sleep(delay)
      }).pipe(
        Effect.forever,
        Effect.tapError(() => runnerWarning("runner.lease.expired", {})),
      )
      return yield* Effect.raceFirst(
        Fiber.join(reader).pipe(
          Effect.tapError(() => runnerWarning("runner.socket.closed", {})),
          Effect.mapError(() => failure("Runner controller connection closed")),
        ),
        Effect.raceFirst(
          consumeApi(incoming, sessions, operations, persist),
          Effect.raceFirst(heartbeat, leaseWatchdog),
        ),
      )
    }).pipe(Effect.ensuring(Ref.set(activeWriter, undefined))),
  )

export const foregroundRunnerLayer = Layer.mergeAll(
  BunSocket.layerWebSocketConstructor,
  BunCrypto.layer,
  BunFileSystem.layer,
)

const runnerSource = (options: ForegroundRunnerOptions) => options.resume?.executorUrl ?? options.admission?.executorUrl
const workspaceIdentityFor = (options: ForegroundRunnerOptions) =>
  options.resume?.workspaceIdentity ?? options.admission?.workspaceIdentity
const initialNativeToolStates = (resume: ForegroundRunnerSnapshot | undefined) =>
  new Map((resume?.machines ?? []).map(({ machineId, state }) => [machineId, state] as const))

export const runForegroundRunner = (
  options: ForegroundRunnerOptions,
): Effect.Effect<void, ForegroundRunnerError, Crypto.Crypto | FileSystem.FileSystem | Socket.WebSocketConstructor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = runnerSource(options)
      if (source === undefined) return yield* failure("Runner endpoint is unavailable")
      const url = yield* runnerUrl(
        source,
        options.resume === undefined ? options.admission?.expiresAt : undefined,
        options.trustedOrigin,
      )
      const crypto = yield* Crypto.Crypto
      const processIncarnation =
        options.resume?.access.fence.processIncarnation ??
        (yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => failure("Could not create the local process incarnation")),
        ))
      const sessions = yield* Ref.make<LocalSession | undefined>(initialSessionFor(options.resume))
      const nativeToolStates = yield* Ref.make(initialNativeToolStates(options.resume))
      const activeWriter = yield* Ref.make<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>(
        undefined,
      )
      const workspaceIdentity = workspaceIdentityFor(options)
      if (workspaceIdentity === undefined) return yield* failure("Runner Workspace identity is unavailable")
      const receiptStore = options.receiptStore
      const receiptScope = options.receiptScope
      const persistLock = yield* Semaphore.make(1)
      const saveSnapshot = () =>
        receiptStore === undefined || receiptScope === undefined
          ? Effect.void
          : Effect.gen(function* () {
              const session = yield* Ref.get(sessions)
              if (session === undefined) return
              yield* receiptStore.save(receiptScope, {
                version: 1,
                workspaceIdentity,
                executorUrl: url,
                access: access(session),
                leaseExpiresAt: session.leaseExpiresAt,
                heartbeatIntervalMillis: session.heartbeatIntervalMillis,
                cursor: session.cursor,
                machines: Array.from(yield* Ref.get(nativeToolStates), ([machineId, state]) => ({
                  machineId,
                  state,
                })),
              })
            })
      const persist = () => persistLock.withPermits(1)(saveSnapshot())
      const nativeToolContext = yield* Layer.build(
        nativeToolLayer({
          workspace: options.workspacePath,
          read: (operationId) => Effect.map(Ref.get(nativeToolStates), (states) => states.get(operationId)),
          write: (operationId, state) =>
            Ref.update(nativeToolStates, (states) => new Map(states).set(operationId, state)).pipe(
              Effect.andThen(persist()),
              Effect.mapError((error) => NativeToolError.make({ message: error.message })),
            ),
        }),
      )
      const nativeTool = Context.get(nativeToolContext, NativeToolService)
      const currentAccess = Ref.get(sessions).pipe(
        Effect.flatMap((session) =>
          session === undefined
            ? Effect.fail(
                Operations.OperationError.make({ kind: "execution", message: "Runner session is unavailable" }),
              )
            : Effect.succeed(access(session)),
        ),
      )
      const operations = yield* Operations.make({
        access: currentAccess,
        emit: (event) =>
          Ref.get(activeWriter).pipe(
            Effect.flatMap((writer) =>
              writer === undefined
                ? Effect.fail(
                    Operations.OperationError.make({ kind: "transport", message: "Runner transport is unavailable" }),
                  )
                : writer(encodeRunnerMessage(event)).pipe(
                    Effect.mapError(() =>
                      Operations.OperationError.make({
                        kind: "transport",
                        message: "Could not write Runner operation",
                      }),
                    ),
                  ),
            ),
          ),
        machine: {
          execute: (input) =>
            nativeTool
              .execute({
                machineId: input.machineId,
                requestDigest: input.requestDigest,
                request: input.request,
              })
              .pipe(
                Effect.mapError((error) =>
                  Operations.OperationError.make({ kind: "execution", message: error.message }),
                ),
              ),
          cancel: (input) =>
            nativeTool
              .cancel(input)
              .pipe(
                Effect.mapError((error) =>
                  Operations.OperationError.make({ kind: "execution", message: error.message }),
                ),
              ),
        },
      })
      const workspaceCapabilities = yield* inspectWorkspaceCapabilities({
        target: "runner",
        workspacePath: options.workspacePath,
        nativeTools: true,
        pty: false,
      })
      const connection = connected(
        options,
        url,
        processIncarnation,
        workspaceCapabilities,
        sessions,
        activeWriter,
        operations,
        persist,
      ).pipe(
        Effect.catch((error: ForegroundRunnerError) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(sessions)) === undefined) return yield* error
            yield* runnerWarning("runner.socket.reconnecting", {
              "rika.outcome": consumeFailureKind(error.message),
            })
            yield* Effect.sleep("250 millis")
          }),
        ),
      )
      return yield* Effect.forever(connection).pipe(
        Effect.tapError((error) =>
          options.ready === undefined ? Effect.void : Deferred.fail(options.ready, error).pipe(Effect.asVoid),
        ),
      )
    }),
  )
