import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { BunFileSystem } from "@effect/platform-bun"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import {
  Clock,
  Config,
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
import { BindingProxyError, type Transport as BindingTransport } from "../protocol/binding-proxy"
import { CellError, State as CellStateSchema, type State as CellState } from "../protocol/cells"
import * as Operations from "../protocol/operations"
import * as HostedKernel from "./kernel"
import { Machine, MachineError, State as MachineState, workspaceLayer as machineLayer } from "./machine"
import {
  AccessWire,
  ApiMessage,
  type ApiMessage as IncomingMessage,
  emptyCursor,
  type Fence,
  RunnerAdmissionWire,
  RunnerMessage,
  type ResumeCursors,
  type WelcomeWire,
} from "../protocol/messages"
import { inspectWorkspaceCapabilities } from "../workspace/capabilities"

/** A local filesystem root. This value is never serialized or sent on the wire. */
export interface ForegroundRunnerOptions {
  readonly admission?: RunnerAdmissionWire
  readonly resume?: ForegroundRunnerSnapshot
  readonly workspacePath: string
  /** Completes after the controller has authenticated the admission. */
  readonly ready?: Deferred.Deferred<void, ForegroundRunnerError>
  /** Trusted hosted HTTPS origin used to pin the returned WSS endpoint. */
  readonly trustedOrigin?: string
  /** Optional encrypted-at-rest receipt/session persistence supplied by the host. */
  readonly receiptStore?: ForegroundRunnerReceiptStore
  /** Opaque host-local key for the receipt/session record. */
  readonly receiptScope?: string
}

export class ForegroundRunnerError extends Schema.TaggedError<ForegroundRunnerError>()("ForegroundRunnerError", {
  message: Schema.String,
}) {}

const ForegroundReceipt = Operations.OperationReceipt
export type ForegroundReceipt = typeof ForegroundReceipt.Type

export const ForegroundRunnerSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  workspaceIdentity: Schema.String.check(Schema.isMinLength(1)),
  executorUrl: Schema.String.check(Schema.isMinLength(1)),
  access: AccessWire,
  leaseExpiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: Schema.Struct({ sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), value: Schema.String }),
  receipts: Schema.Array(ForegroundReceipt),
  cells: Schema.Array(Schema.Struct({ executionKey: Schema.String, state: CellStateSchema })),
  machines: Schema.Array(Schema.Struct({ machineId: Schema.String, state: MachineState })),
})
export type ForegroundRunnerSnapshot = typeof ForegroundRunnerSnapshot.Type

export interface ForegroundRunnerReceiptStore {
  readonly save: (scope: string, snapshot: ForegroundRunnerSnapshot) => Effect.Effect<void, ForegroundRunnerError>
}

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const encodeRunnerMessage = Schema.encodeSync(Schema.fromJsonString(RunnerMessage))
const localCapabilities = { cells: true, checkpoints: false, pty: false } as const
const initialCursors: ResumeCursors = { command: 0, event: 0, pty: 0 }

const failure = (message: string) => ForegroundRunnerError.make({ message })

const sameFence = (left: Fence, right: Fence) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.assignmentGeneration === right.assignmentGeneration &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId &&
  left.processIncarnation === right.processIncarnation

const sameAccess = (left: AccessWire, right: AccessWire) =>
  left.version === right.version &&
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  sameFence(left.fence, right.fence)

const runnerUrl = (
  value: string,
  expiresAt: number | undefined,
  trustedOrigin: string | undefined,
): Effect.Effect<string, ForegroundRunnerError> =>
  Effect.gen(function* () {
    if (expiresAt !== undefined && expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* failure("Runner admission has expired")
    return yield* Effect.try({
      try: () => {
        const url = new URL(value)
        if (
          url.protocol !== "wss:" ||
          url.pathname !== "/api/v1/runners" ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.search.length > 0 ||
          url.hash.length > 0
        )
          throw new Error("Runner URL is not a pinned wss:// endpoint")
        if (trustedOrigin !== undefined) {
          const origin = new URL(trustedOrigin)
          if (origin.protocol !== "https:" || `wss://${origin.host}` !== url.origin)
            throw new Error("Runner URL is outside the trusted hosted origin")
        }
        return url.toString()
      },
      catch: () => failure("Runner URL must be a pinned wss:// endpoint"),
    })
  })

interface LocalSession {
  readonly fence: Fence
  readonly leaseEpoch: number
  readonly sessionToken: string
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: typeof emptyCursor
}

const access = (session: LocalSession): AccessWire => ({
  version: 1,
  fence: session.fence,
  leaseEpoch: session.leaseEpoch,
  sessionToken: session.sessionToken,
})

const sessionFromWelcome = (
  welcome: WelcomeWire,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    if (welcome.fence.target !== "runner") return yield* failure("Runner welcome has a non-Runner fence")
    if (welcome.fence.processIncarnation !== processIncarnation)
      return yield* failure("Runner welcome has a different process incarnation")
    return {
      fence: welcome.fence,
      leaseEpoch: welcome.leaseEpoch,
      sessionToken: welcome.sessionToken,
      leaseExpiresAt: welcome.leaseExpiresAt,
      heartbeatIntervalMillis: welcome.heartbeatIntervalMillis,
      cursor: welcome.cursor,
    }
  })

const waitForWelcome = (
  incoming: Queue.Queue<IncomingMessage>,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "ExecutorWelcome") return yield* sessionFromWelcome(message.welcome, processIncarnation)
    return yield* waitForWelcome(incoming, processIncarnation)
  })

const sessionFromReconnect = (
  welcome: Extract<IncomingMessage, { readonly _tag: "ExecutorReconnected" }>["welcome"],
  previous: LocalSession,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    if (!sameFence(welcome.fence, previous.fence) || welcome.fence.processIncarnation !== processIncarnation)
      return yield* failure("Runner reconnect has a different fence")
    return {
      ...previous,
      leaseEpoch: welcome.leaseEpoch,
      leaseExpiresAt: welcome.leaseExpiresAt,
      heartbeatIntervalMillis: welcome.heartbeatIntervalMillis,
      cursor: welcome.cursor,
    }
  })

const waitForReconnect = (
  incoming: Queue.Queue<IncomingMessage>,
  previous: LocalSession,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundRunnerError> =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "ExecutorReconnected")
      return yield* sessionFromReconnect(message.welcome, previous, processIncarnation)
    return yield* waitForReconnect(incoming, previous, processIncarnation)
  })

const inMemoryCells = (
  workspaceIdentity: string,
  workspacePath: string,
  states: Ref.Ref<Map<string, CellState>>,
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
  sendBinding: BindingTransport["send"],
) =>
  Effect.gen(function* () {
    const temporaryDirectory = yield* Config.string("TMPDIR").pipe(
      Config.withDefault("/tmp"),
      Effect.mapError(() => failure("Temporary directory configuration is invalid")),
    )
    return yield* HostedKernel.make({
      workspaceIdentity,
      workspacePath,
      dataRoot: `${temporaryDirectory}/rika-kernel/${encodeURIComponent(workspaceIdentity)}`,
      read: (operationKey) => Effect.map(Ref.get(states), (values) => values.get(operationKey)),
      write: (operationKey, state) =>
        Ref.update(states, (values) => new Map(values).set(operationKey, state)).pipe(
          Effect.andThen(persist()),
          Effect.mapError((error) => CellError.make({ kind: "execution", message: error.message })),
        ),
      sendBinding,
    })
  })

const consumeApi = (
  incoming: Queue.Queue<IncomingMessage>,
  session: Ref.Ref<LocalSession | undefined>,
  cells: HostedKernel.Interface,
  operations: Operations.Interface,
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
) =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "LeaseReceipt") {
      const current = yield* Ref.get(session)
      if (current === undefined) return yield* failure("Runner session is unavailable")
      if (!sameFence(current.fence, message.receipt.fence) || message.receipt.leaseEpoch !== current.leaseEpoch)
        return yield* failure("Runner receipt has a stale session")
      if (message.receipt.cursor.sequence < current.cursor.sequence)
        return yield* failure("Runner receipt moved the cursor backwards")
      if (
        message.receipt.cursor.sequence === current.cursor.sequence &&
        message.receipt.cursor.value !== current.cursor.value
      )
        return yield* failure("Runner receipt conflicts at the current cursor")
      yield* Ref.set(session, {
        ...current,
        leaseExpiresAt: message.receipt.leaseExpiresAt,
        cursor: message.receipt.cursor,
      })
      yield* persist()
    }
    if (message._tag === "BindingResult") {
      const current = yield* Ref.get(session)
      if (current === undefined || !sameAccess(access(current), message.access))
        return yield* failure("Local binding result has a stale session")
      yield* cells.completeBinding(message).pipe(Effect.mapError((error) => failure(error.message)))
    }
    if (
      message._tag === "CellCancel" ||
      message._tag === "CellExecute" ||
      message._tag === "CellReplay" ||
      message._tag === "CellTerminalReceipt" ||
      message._tag === "CellTerminalSuperseded" ||
      message._tag === "LocalCellReceipt" ||
      message._tag === "MachineExecute"
    )
      yield* operations.dispatch(message).pipe(Effect.mapError((error) => failure(error.message)))
  }).pipe(Effect.forever)

const connected = (
  options: ForegroundRunnerOptions,
  url: string,
  processIncarnation: string,
  workspaceCapabilities: WorkspaceCapabilitySnapshot,
  sessions: Ref.Ref<LocalSession | undefined>,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  cells: HostedKernel.Interface,
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
          : writer(encodeRunnerMessage({ _tag: "ExecutorReconnect", access: access(previous) })).pipe(
              Effect.mapError(() => failure("Could not write Runner reconnect")),
            )
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
      yield* cells.replayBindings(access(session)).pipe(Effect.mapError((error) => failure(error.message)))
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
            ).pipe(Effect.mapError(() => failure("Could not write Runner heartbeat")))
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
      }).pipe(Effect.forever)
      return yield* Effect.raceFirst(
        Fiber.join(reader).pipe(Effect.mapError(() => failure("Runner controller connection closed"))),
        Effect.raceFirst(
          consumeApi(incoming, sessions, cells, operations, persist),
          Effect.raceFirst(heartbeat, leaseWatchdog),
        ),
      )
    }).pipe(Effect.ensuring(Ref.set(activeWriter, undefined))),
  )

/**
 * Run one foreground Runner executor for the lifetime of the calling scope.
 * It opens one outbound WSS connection, reconnects with the persisted in-process
 * session, and keeps workspace execution state out of the controller.
 */
export const foregroundRunnerLayer = Layer.mergeAll(
  BunSocket.layerWebSocketConstructor,
  BunCrypto.layer,
  BunFileSystem.layer,
)

export const runForegroundRunner = (
  options: ForegroundRunnerOptions,
): Effect.Effect<void, ForegroundRunnerError, Crypto.Crypto | FileSystem.FileSystem | Socket.WebSocketConstructor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = options.resume?.executorUrl ?? options.admission?.executorUrl
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
      const initialSession =
        options.resume === undefined
          ? undefined
          : {
              fence: options.resume.access.fence,
              leaseEpoch: options.resume.access.leaseEpoch,
              sessionToken: options.resume.access.sessionToken,
              leaseExpiresAt: options.resume.leaseExpiresAt,
              heartbeatIntervalMillis: options.resume.heartbeatIntervalMillis,
              cursor: options.resume.cursor,
            }
      const sessions = yield* Ref.make<LocalSession | undefined>(initialSession)
      const initialReceipts = new Map<string, ReadonlyArray<import("../protocol/messages").CellLifecycleFrame>>(
        (options.resume?.receipts ?? []).map((receipt) => [
          Operations.executionKey(receipt.operationKey, receipt.frames[0].attribution.attempt),
          receipt.frames,
        ]),
      )
      const receipts = yield* Ref.make(initialReceipts)
      const cellStates = yield* Ref.make(
        new Map(
          (options.resume === undefined ? [] : options.resume.cells).map(
            ({ executionKey: key, state }) => [key, state] as const,
          ),
        ),
      )
      const machineStates = yield* Ref.make(
        new Map((options.resume?.machines ?? []).map(({ machineId, state }) => [machineId, state] as const)),
      )
      const activeWriter = yield* Ref.make<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>(
        undefined,
      )
      const workspaceIdentity = options.resume?.workspaceIdentity ?? options.admission?.workspaceIdentity
      if (workspaceIdentity === undefined) return yield* failure("Runner Workspace identity is unavailable")
      const receiptStore = options.receiptStore
      const receiptScope = options.receiptScope
      const persistLock = yield* Semaphore.make(1)
      const saveSnapshot = (operationReceipts: Operations.ReceiptMap) =>
        receiptStore === undefined || receiptScope === undefined
          ? Effect.void
          : Effect.gen(function* () {
              const session = yield* Ref.get(sessions)
              if (session === undefined) return
              const storedReceipts = [...operationReceipts.values()].flatMap((frames) => {
                const first = frames[0]
                return first === undefined
                  ? []
                  : [
                      Operations.OperationReceipt.make({
                        operationKey: first.attribution.operationKey,
                        frames: [first, ...frames.slice(1)],
                      }),
                    ]
              })
              yield* receiptStore.save(receiptScope, {
                version: 1,
                workspaceIdentity,
                executorUrl: url,
                access: access(session),
                leaseExpiresAt: session.leaseExpiresAt,
                heartbeatIntervalMillis: session.heartbeatIntervalMillis,
                cursor: session.cursor,
                receipts: storedReceipts,
                cells: Array.from(yield* Ref.get(cellStates), ([key, state]) => ({ executionKey: key, state })),
                machines: Array.from(yield* Ref.get(machineStates), ([machineId, state]) => ({ machineId, state })),
              })
            })
      const persist = () => persistLock.withPermits(1)(Effect.flatMap(Ref.get(receipts), saveSnapshot))
      const commitReceipts = (next: Operations.ReceiptMap) =>
        persistLock.withPermits(1)(saveSnapshot(next).pipe(Effect.andThen(Ref.set(receipts, next))))
      const cells = yield* inMemoryCells(workspaceIdentity, options.workspacePath, cellStates, persist, (message) =>
        Effect.gen(function* () {
          const session = yield* Ref.get(sessions)
          const writer = yield* Ref.get(activeWriter)
          if (session === undefined || writer === undefined)
            return yield* BindingProxyError.make({
              message: "Local binding transport is unavailable",
            })
          yield* writer(encodeRunnerMessage({ _tag: "BindingInvoke", ...message, access: access(session) })).pipe(
            Effect.mapError(() => BindingProxyError.make({ message: "Could not write local binding request" })),
          )
        }),
      )
      const machineContext = yield* Layer.build(
        machineLayer({
          workspace: options.workspacePath,
          read: (machineId) => Effect.map(Ref.get(machineStates), (states) => states.get(machineId)),
          write: (machineId, state) =>
            Ref.update(machineStates, (states) => new Map(states).set(machineId, state)).pipe(
              Effect.andThen(persist()),
              Effect.mapError((error) => MachineError.make({ message: error.message })),
            ),
        }),
      )
      const machine = Context.get(machineContext, Machine)
      const cellOperationFailure = (error: CellError | BindingProxyError) =>
        Operations.OperationError.make({
          kind: error._tag === "CellError" ? error.kind : "execution",
          message: error.message,
        })
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
        receipts: {
          current: Ref.get(receipts),
          commit: (next) =>
            commitReceipts(next).pipe(
              Effect.mapError((error) =>
                Operations.OperationError.make({ kind: "persistence", message: error.message }),
              ),
            ),
        },
        emit: (event) =>
          Ref.get(activeWriter).pipe(
            Effect.flatMap((writer) =>
              writer === undefined
                ? Effect.fail(
                    Operations.OperationError.make({ kind: "transport", message: "Runner transport is unavailable" }),
                  )
                : writer(
                    encodeRunnerMessage(
                      event._tag === "CellResult" ? { ...event, _tag: "LocalCellResult" as const } : event,
                    ),
                  ).pipe(
                    Effect.mapError(() =>
                      Operations.OperationError.make({
                        kind: "transport",
                        message: "Could not write Runner operation",
                      }),
                    ),
                  ),
            ),
          ),
        cell: {
          prepare: (request) =>
            Effect.succeed({
              secrets: [],
              execute: (output) => cells.execute(request, output).pipe(Effect.mapError(cellOperationFailure)),
            }),
          admit: (request) => cells.admit(request).pipe(Effect.mapError(cellOperationFailure)),
          cancel: (operationKey, attempt) =>
            cells
              .cancel(operationKey, attempt)
              .pipe(
                Effect.mapError((error) =>
                  Operations.OperationError.make({ kind: error.kind, message: error.message }),
                ),
              ),
          replayBindings: (current) => cells.replayBindings(current).pipe(Effect.mapError(cellOperationFailure)),
        },
        machine: {
          execute: (input) =>
            machine
              .execute(input)
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
        typescriptKernel: true,
        pty: false,
      })
      const connection = connected(
        options,
        url,
        processIncarnation,
        workspaceCapabilities,
        sessions,
        activeWriter,
        cells,
        operations,
        persist,
      ).pipe(
        Effect.catch((error: ForegroundRunnerError) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(sessions)) === undefined) return yield* error
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
