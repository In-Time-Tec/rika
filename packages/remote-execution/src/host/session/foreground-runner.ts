import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { BunFileSystem } from "@effect/platform-bun"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { runnerProtocolVersion } from "@rika/product/runner-registration"
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
import { BindingProxyError, type Transport as BindingTransport } from "../../protocol/binding-proxy"
import { CellError, type State as CellState } from "../../protocol/cells"
import * as Operations from "../../protocol/operations"
import * as HostedKernel from "../kernel"
import { Machine, MachineError, workspaceLayer as machineLayer } from "../machinery/machine"
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

const {
  access,
  applyLeaseReceipt,
  failure,
  initialSessionFor,
  runnerUrl,
  sameAccess,
  waitForReconnect,
  waitForWelcome,
} = ForegroundSession

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const encodeRunnerMessage = Schema.encodeSync(Schema.fromJsonString(RunnerMessage))
const localCapabilities = { cells: true, checkpoints: false, pty: false } as const
const initialCursors: ResumeCursors = { command: 0, event: 0, pty: 0 }

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

const isOperationMessage = (message: IncomingMessage): message is Parameters<Operations.Interface["dispatch"]>[0] =>
  message._tag === "CellCancel" ||
  message._tag === "CellExecute" ||
  message._tag === "CellReplay" ||
  message._tag === "CellTerminalReceipt" ||
  message._tag === "CellTerminalSuperseded" ||
  message._tag === "LocalCellReceipt" ||
  message._tag === "MachineExecute"

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
    if (message._tag === "LeaseReceipt") yield* applyLeaseReceipt(message, session, persist)
    if (message._tag === "BindingResult") {
      const current = yield* Ref.get(session)
      if (current === undefined || !sameAccess(access(current), message.access))
        return yield* failure("Local binding result has a stale session")
      yield* cells.completeBinding(message).pipe(Effect.mapError((error) => failure(error.message)))
    }
    if (isOperationMessage(message))
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

export const foregroundRunnerLayer = Layer.mergeAll(
  BunSocket.layerWebSocketConstructor,
  BunCrypto.layer,
  BunFileSystem.layer,
)

const runnerSource = (options: ForegroundRunnerOptions) => options.resume?.executorUrl ?? options.admission?.executorUrl
const workspaceIdentityFor = (options: ForegroundRunnerOptions) =>
  options.resume?.workspaceIdentity ?? options.admission?.workspaceIdentity
const initialCellStates = (resume: ForegroundRunnerSnapshot | undefined) =>
  new Map((resume?.cells ?? []).map(({ executionKey, state }) => [executionKey, state] as const))
const initialMachineStates = (resume: ForegroundRunnerSnapshot | undefined) =>
  new Map((resume?.machines ?? []).map(({ machineId, state }) => [machineId, state] as const))
const initialOperationReceipts = (resume: ForegroundRunnerSnapshot | undefined) =>
  new Map<string, ReadonlyArray<import("../../protocol/messages").CellLifecycleFrame>>(
    (resume?.receipts ?? []).map((receipt) => [
      Operations.executionKey(receipt.operationKey, receipt.frames[0].attribution.attempt),
      receipt.frames,
    ]),
  )

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
      const receipts = yield* Ref.make(initialOperationReceipts(options.resume))
      const cellStates = yield* Ref.make(initialCellStates(options.resume))
      const machineStates = yield* Ref.make(initialMachineStates(options.resume))
      const activeWriter = yield* Ref.make<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>(
        undefined,
      )
      const workspaceIdentity = workspaceIdentityFor(options)
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
