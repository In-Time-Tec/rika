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
  Random,
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
import type {
  ForegroundRunnerOptions,
  ForegroundRunnerSnapshot,
  RetainedProcessObservation,
} from "./foreground-contract"
import { ForegroundRunnerError } from "./foreground-contract"
import { ForegroundSession, type LocalSession } from "./foreground-session"

export * from "./foreground-contract"

const { access, applyLeaseReceipt, failure, initialSessionFor, runnerUrl, waitForReconnect, waitForWelcome } =
  ForegroundSession

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const encodeRunnerMessage = Schema.encodeSync(Schema.fromJsonString(RunnerMessage))
const localCapabilities = { nativeTools: true, checkpoints: false, pty: false } as const
const initialCursors: ResumeCursors = { command: 0, event: 0, pty: 0 }

const socketFailure = (error: Socket.SocketError | ForegroundRunnerError) => {
  if (Schema.is(ForegroundRunnerError)(error)) return error
  const reason = error.reason
  if (reason._tag === "SocketCloseError")
    return failure(
      `Runner controller connection closed (${reason.code})`,
      reason.code !== 1002 && reason.code !== 1003 && reason.code !== 1008,
    )
  return failure("Runner controller connection failed")
}

const isOperationMessage = (message: IncomingMessage): message is Parameters<Operations.Interface["dispatch"]>[0] =>
  message._tag === "MachineExecute" || message._tag === "MachineCancel"

const consumeApi = (
  incoming: Queue.Queue<IncomingMessage>,
  session: Ref.Ref<LocalSession | undefined>,
  operations: Operations.Interface,
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
  observations: Ref.Ref<Map<string, RetainedProcessObservation>>,
) =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    yield* runnerEvent("runner.message.received", messageCorrelation(message))
    if (message._tag === "Fenced") {
      yield* runnerWarning("runner.fenced", messageCorrelation(message))
      return yield* failure(message.message, false)
    }
    if (message._tag === "LeaseReceipt") yield* applyLeaseReceipt(message, session, persist)
    if (message._tag === "ProcessObservationAck") {
      yield* Ref.update(observations, (current) => {
        const next = new Map(current)
        next.delete(`${message.machineId}\u0000${message.processId}`)
        return next
      })
      yield* persist()
    }
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
  observations: Ref.Ref<Map<string, RetainedProcessObservation>>,
  onConnected: (at: number) => void,
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
              Effect.mapError(() => failure("Controller sent an invalid Runner frame", false)),
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
                Effect.mapError(socketFailure),
                Effect.flatMap(() => failure("Runner controller connection closed before welcome")),
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
                Effect.mapError(socketFailure),
                Effect.flatMap(() => failure("Runner controller connection closed before reconnect")),
              ),
            ).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () => failure("Runner controller did not accept the reconnect"),
              }),
            )
      yield* Ref.set(sessions, session)
      yield* Ref.set(activeWriter, writer)
      onConnected(yield* Clock.currentTimeMillis)
      yield* runnerEvent(previous === undefined ? "runner.socket.welcome" : "runner.socket.reconnected", {})
      yield* persist()
      for (const observation of (yield* Ref.get(observations)).values())
        yield* writer(
          encodeRunnerMessage({ _tag: "ProcessObservation", ...observation, access: access(session) }),
        ).pipe(Effect.mapError(() => failure("Could not replay Runner process observation")))
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
        if (delay <= 0) return yield* failure("Runner controller stopped renewing the executor lease", false)
        yield* Effect.sleep(delay)
      }).pipe(
        Effect.forever,
        Effect.tapError(() => runnerWarning("runner.lease.expired", {})),
      )
      return yield* Effect.raceFirst(
        Fiber.join(reader).pipe(
          Effect.tapError(() => runnerWarning("runner.socket.closed", {})),
          Effect.mapError(socketFailure),
          Effect.flatMap(() => failure("Runner controller connection closed")),
        ),
        Effect.raceFirst(
          consumeApi(incoming, sessions, operations, persist, observations),
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
      const processObservations = yield* Ref.make(
        new Map(
          (options.resume?.observations ?? []).map((observation) => [
            `${observation.machineId}\u0000${observation.observation.processId}`,
            observation,
          ]),
        ),
      )
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
                observations: Array.from((yield* Ref.get(processObservations)).values()),
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
          (event._tag === "ProcessObservation"
            ? Ref.update(processObservations, (current) =>
                new Map(current).set(`${event.machineId}\u0000${event.observation.processId}`, {
                  operationKey: event.operationKey,
                  attempt: event.attempt,
                  machineId: event.machineId,
                  requestDigest: event.requestDigest,
                  observation: event.observation,
                }),
              ).pipe(Effect.andThen(persist()))
            : Effect.void
          ).pipe(
            Effect.mapError((error) => Operations.OperationError.make({ kind: "transport", message: error.message })),
            Effect.andThen(Ref.get(activeWriter)),
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
          observe: (processId) =>
            nativeTool
              .observe(processId)
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
      let failedAttempts = 0
      let connectedAt: number | undefined
      const connection = connected(
        options,
        url,
        processIncarnation,
        workspaceCapabilities,
        sessions,
        activeWriter,
        operations,
        persist,
        processObservations,
        (at) => {
          connectedAt = at
        },
      ).pipe(
        Effect.catch((error: ForegroundRunnerError) =>
          Effect.gen(function* () {
            if (error.retryable === false || (yield* Ref.get(sessions)) === undefined) return yield* error
            const now = yield* Clock.currentTimeMillis
            if (connectedAt !== undefined && now - connectedAt >= 30_000) failedAttempts = 0
            connectedAt = undefined
            const ceiling = Math.min(30_000, 250 * 2 ** Math.min(failedAttempts++, 7))
            const delay = Math.round(ceiling * (0.75 + (yield* Random.next) * 0.25))
            yield* runnerWarning("runner.socket.reconnecting", {
              "rika.outcome": consumeFailureKind(error.message),
              "rika.reconnect.delay.ms": delay,
              "rika.reconnect.attempt": failedAttempts,
            })
            yield* Effect.sleep(delay)
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
