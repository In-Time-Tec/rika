import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Clock, Context, Crypto, Deferred, Effect, Fiber, FiberSet, Layer, Queue, Ref, Schema, Semaphore } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { CellError, Cells, layer as cellsLayer, type State as CellState } from "./cells"
import {
  AccessWire,
  ApiMessage,
  CellResponse,
  type ApiMessage as IncomingMessage,
  type CellRequest,
  emptyCursor,
  type Fence,
  LocalExecutorAdmissionWire,
  LocalExecutorMessage,
  type ResumeCursors,
  type WelcomeWire,
} from "./protocol"

/** A local filesystem root. This value is never serialized or sent on the wire. */
export interface ForegroundLocalExecutorOptions {
  readonly admission?: LocalExecutorAdmissionWire
  readonly resume?: ForegroundLocalExecutorSnapshot
  readonly workspacePath: string
  /** Completes after the controller has authenticated the admission. */
  readonly ready?: Deferred.Deferred<void, ForegroundLocalExecutorError>
  /** Trusted hosted HTTPS origin used to pin the returned WSS endpoint. */
  readonly trustedOrigin?: string
  /** Optional encrypted-at-rest receipt/session persistence supplied by the host. */
  readonly receiptStore?: ForegroundLocalExecutorReceiptStore
  /** Opaque host-local key for the receipt/session record. */
  readonly receiptScope?: string
}

export class ForegroundLocalExecutorError extends Schema.TaggedError<ForegroundLocalExecutorError>()(
  "ForegroundLocalExecutorError",
  { message: Schema.String },
) {}

const ReceiptState = Schema.Literals(["running", "completed"])
const ForegroundReceipt = Schema.Struct({
  operationKey: Schema.String.check(Schema.isMinLength(1)),
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: ReceiptState,
  response: Schema.optionalKey(CellResponse),
})
export type ForegroundReceipt = typeof ForegroundReceipt.Type

export const ForegroundLocalExecutorSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  workspaceIdentity: Schema.String.check(Schema.isMinLength(1)),
  executorUrl: Schema.String.check(Schema.isMinLength(1)),
  access: AccessWire,
  leaseExpiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  heartbeatIntervalMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  cursor: Schema.Struct({ sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), value: Schema.String }),
  receipts: Schema.Array(ForegroundReceipt),
})
export type ForegroundLocalExecutorSnapshot = typeof ForegroundLocalExecutorSnapshot.Type

export interface ForegroundLocalExecutorReceiptStore {
  readonly save: (
    scope: string,
    snapshot: ForegroundLocalExecutorSnapshot,
  ) => Effect.Effect<void, ForegroundLocalExecutorError>
}

const decodeApiMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiMessage))
const encodeLocalExecutorMessage = Schema.encodeSync(Schema.fromJsonString(LocalExecutorMessage))
const maximumOutputLength = 1_000_000
const localCapabilities = { cells: true, checkpoints: false, pty: false } as const
const initialCursors: ResumeCursors = { command: 0, event: 0, pty: 0 }
const unknownResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "unknown", message: "Local operation outcome is unknown after foreground restart" },
}

const failure = (message: string) => ForegroundLocalExecutorError.make({ message })

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

const localExecutorUrl = (
  value: string,
  expiresAt: number | undefined,
  trustedOrigin: string | undefined,
): Effect.Effect<string, ForegroundLocalExecutorError> =>
  Effect.gen(function* () {
    if (expiresAt !== undefined && expiresAt <= (yield* Clock.currentTimeMillis))
      return yield* failure("Local executor admission has expired")
    return yield* Effect.try({
      try: () => {
        const url = new URL(value)
        if (
          url.protocol !== "wss:" ||
          url.pathname !== "/api/v1/local-executors" ||
          url.username.length > 0 ||
          url.password.length > 0 ||
          url.search.length > 0 ||
          url.hash.length > 0
        )
          throw new Error("Local executor URL is not a pinned wss:// endpoint")
        if (trustedOrigin !== undefined) {
          const origin = new URL(trustedOrigin)
          if (origin.protocol !== "https:" || `wss://${origin.host}` !== url.origin)
            throw new Error("Local executor URL is outside the trusted hosted origin")
        }
        return url.toString()
      },
      catch: () => failure("Local executor URL must be a pinned wss:// endpoint"),
    })
  })

const readLimited = (
  stream: ReadableStream<Uint8Array>,
): Effect.Effect<{ readonly text: string; readonly truncated: boolean }, CellError> =>
  Effect.callback((resume, signal) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ""
    let finished = false
    const finish = (effect: Effect.Effect<{ readonly text: string; readonly truncated: boolean }, CellError>) => {
      if (finished) return
      finished = true
      resume(effect)
    }
    const pump = (): void => {
      reader.read().then(
        (chunk) => {
          if (chunk.done) {
            finish(Effect.succeed({ text, truncated: false }))
            return
          }
          const decoded = decoder.decode(chunk.value, { stream: true })
          if (text.length + decoded.length > maximumOutputLength) {
            text += decoded.slice(0, Math.max(0, maximumOutputLength - text.length))
            finish(Effect.succeed({ text, truncated: true }))
            void reader.cancel()
            return
          }
          text += decoded
          pump()
        },
        () => finish(Effect.fail(CellError.make({ kind: "execution", message: "Could not read cell output" }))),
      )
    }
    signal.addEventListener(
      "abort",
      () => {
        void reader.cancel()
      },
      { once: true },
    )
    pump()
    return Effect.sync(() => {
      void reader.cancel()
    })
  })

const executeCell = (
  workspacePath: string,
  request: { readonly workspace: string; readonly code: string },
): Effect.Effect<CellResponse, CellError> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => Bun.spawn(["/bin/sh", "-c", request.code], { cwd: workspacePath, stdout: "pipe", stderr: "pipe" }),
      catch: () => CellError.make({ kind: "execution", message: "Could not start cell" }),
    }),
    (process) =>
      Effect.all(
        [
          Effect.tryPromise({
            try: () => process.exited,
            catch: () => CellError.make({ kind: "execution", message: "Cell process failed" }),
          }),
          readLimited(process.stdout),
          readLimited(process.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.timeoutOrElse({
          duration: "5 minutes",
          orElse: () => Effect.fail(CellError.make({ kind: "execution", message: "Cell process timed out" })),
        }),
        Effect.map(([exitCode, stdout, stderr]) => {
          const result = {
            exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
          }
          return exitCode === 0
            ? ({ _tag: "Success", result } as const)
            : ({ _tag: "DomainFailure", failure: result } as const)
        }),
      ),
    (process) => Effect.sync(() => process.kill()).pipe(Effect.ignore),
  )

interface LocalSession {
  readonly fence: Fence
  readonly leaseEpoch: number
  readonly sessionToken: string
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: typeof emptyCursor
}

interface PendingResult {
  readonly operationKey: string
  readonly attempt: number
  readonly state: "running" | "completed"
  readonly response?: CellResponse
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
): Effect.Effect<LocalSession, ForegroundLocalExecutorError> =>
  Effect.gen(function* () {
    if (welcome.fence.target !== "local_device") return yield* failure("Local executor welcome has a non-local fence")
    if (welcome.fence.processIncarnation !== processIncarnation)
      return yield* failure("Local executor welcome has a different process incarnation")
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
): Effect.Effect<LocalSession, ForegroundLocalExecutorError> =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "ExecutorWelcome") return yield* sessionFromWelcome(message.welcome, processIncarnation)
    return yield* waitForWelcome(incoming, processIncarnation)
  })

const sessionFromReconnect = (
  welcome: Extract<IncomingMessage, { readonly _tag: "ExecutorReconnected" }>['welcome'],
  previous: LocalSession,
  processIncarnation: string,
): Effect.Effect<LocalSession, ForegroundLocalExecutorError> =>
  Effect.gen(function* () {
    if (!sameFence(welcome.fence, previous.fence) || welcome.fence.processIncarnation !== processIncarnation)
      return yield* failure("Local executor reconnect has a different fence")
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
): Effect.Effect<LocalSession, ForegroundLocalExecutorError> =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "ExecutorReconnected")
      return yield* sessionFromReconnect(message.welcome, previous, processIncarnation)
    return yield* waitForReconnect(incoming, previous, processIncarnation)
  })

const inMemoryCells = (workspaceIdentity: string, workspacePath: string) =>
  Effect.gen(function* () {
    const states = yield* Ref.make(new Map<string, CellState>())
    const context = yield* Layer.build(
      cellsLayer({
        workspace: workspaceIdentity,
        read: (operationKey) => Effect.map(Ref.get(states), (values) => values.get(operationKey)),
        write: (operationKey, state) =>
          Ref.update(states, (values) => {
            const next = new Map(values)
            next.set(operationKey, state)
            return next
          }),
        execute: (request) => executeCell(workspacePath, request),
      }),
    )
    return Context.get(context, Cells)
  })

const resolveCellResponse = Effect.fn("ForegroundLocalExecutor.resolveCellResponse")(function* (input: {
  readonly current: LocalSession
  readonly request: CellRequest
  readonly attempt: number
  readonly receipts: Ref.Ref<Map<string, PendingResult>>
  readonly liveOperations: Ref.Ref<Set<string>>
  readonly cells: Cells["Service"]
  readonly persist: () => Effect.Effect<void, ForegroundLocalExecutorError>
}) {
  const operationKey = input.request.operationKey
  const currentReceipt = (yield* Ref.get(input.receipts)).get(operationKey)
  if (currentReceipt !== undefined && input.attempt < currentReceipt.attempt)
    return {
      _tag: "DomainFailure",
      failure: { kind: "fenced", message: "Cell operation attempt is stale" },
    } as const
  if (currentReceipt?.state === "completed" && currentReceipt.response !== undefined) return currentReceipt.response
  if (currentReceipt?.state === "running" && !(yield* Ref.get(input.liveOperations)).has(operationKey)) {
    yield* Ref.update(input.receipts, (values) =>
      new Map(values).set(operationKey, {
        operationKey,
        attempt: currentReceipt.attempt,
        state: "completed",
        response: unknownResponse,
      }),
    )
    yield* input.persist()
    return unknownResponse
  }
  if (currentReceipt === undefined) {
    yield* Ref.update(input.receipts, (values) =>
      new Map(values).set(operationKey, { operationKey, attempt: input.attempt, state: "running" }),
    )
    yield* input.persist()
  }
  return sameAccess(access(input.current), input.request.access)
    ? yield* input.cells.execute(input.request).pipe(
        Effect.catch((error) =>
          Effect.succeed<CellResponse>({
            _tag: "DomainFailure",
            failure: { kind: error.kind, message: error.message },
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed<CellResponse>({
            _tag: "DomainFailure",
            failure: { kind: "execution", message: String(cause) },
          }),
        ),
      )
    : ({
        _tag: "DomainFailure",
        failure: { kind: "fenced", message: "Cell request has a stale executor fence" },
      } as const)
})

const consumeApi = (
  incoming: Queue.Queue<IncomingMessage>,
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  session: Ref.Ref<LocalSession | undefined>,
  receipts: Ref.Ref<Map<string, PendingResult>>,
  liveOperations: Ref.Ref<Set<string>>,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  cells: Cells["Service"],
  persist: () => Effect.Effect<void, ForegroundLocalExecutorError>,
  runWorker: (effect: Effect.Effect<void, ForegroundLocalExecutorError>) => void,
) =>
  Effect.gen(function* () {
    const message = yield* Queue.take(incoming)
    if (message._tag === "Fenced") return yield* failure(message.message)
    if (message._tag === "LeaseReceipt") {
      const current = yield* Ref.get(session)
      if (current === undefined) return yield* failure("Local executor session is unavailable")
      if (!sameFence(current.fence, message.receipt.fence) || message.receipt.leaseEpoch !== current.leaseEpoch)
        return yield* failure("Local executor receipt has a stale session")
      if (message.receipt.cursor.sequence < current.cursor.sequence)
        return yield* failure("Local executor receipt moved the cursor backwards")
      if (
        message.receipt.cursor.sequence === current.cursor.sequence &&
        message.receipt.cursor.value !== current.cursor.value
      )
        return yield* failure("Local executor receipt conflicts at the current cursor")
      yield* Ref.set(session, { ...current, cursor: message.receipt.cursor })
      yield* persist()
    }
    if (message._tag === "LocalCellReceipt") {
      const current = yield* Ref.get(session)
      if (current === undefined) return yield* failure("Local executor session is unavailable")
      if (!sameAccess(access(current), message.access)) return yield* failure("Local executor result receipt is stale")
      yield* Ref.update(receipts, (values) => {
        const pending = values.get(message.operationKey)
        if (pending === undefined || pending.attempt !== message.attempt) return values
        const next = new Map(values)
        next.delete(message.operationKey)
        return next
      })
      yield* persist()
    }
    if (message._tag === "CellExecute") {
      const current = yield* Ref.get(session)
      if (current === undefined) return yield* failure("Local executor session is unavailable")
      const operationKey = message.request.operationKey
      const attempt = message.request.attempt ?? 0
      const known = (yield* Ref.get(receipts)).get(operationKey)
      const live = yield* Ref.get(liveOperations)
      const shouldRun =
        known === undefined ||
        (known.state === "running" && live.has(operationKey))
      if (shouldRun) yield* Ref.update(liveOperations, (values) => new Set(values).add(operationKey))
      const operation = Effect.gen(function* () {
        const response = yield* resolveCellResponse({
          current,
          request: message.request,
          attempt,
          receipts,
          liveOperations,
          cells,
          persist,
        })
        const latest = (yield* Ref.get(session)) ?? current
        yield* Ref.update(receipts, (values) =>
          new Map(values).set(operationKey, { operationKey, attempt, state: "completed", response }),
        )
        yield* persist()
        const currentWriter = (yield* Ref.get(activeWriter)) ?? writer
        yield* currentWriter(
          encodeLocalExecutorMessage({
            _tag: "LocalCellResult",
            access: access(latest),
            operationKey,
            attempt,
            response,
          }),
        ).pipe(Effect.mapError(() => failure("Could not write local cell result")))
      }).pipe(
        Effect.ensuring(Ref.update(liveOperations, (values) => {
          const next = new Set(values)
          next.delete(operationKey)
          return next
        })),
        Effect.ignore,
      )
      yield* Effect.sync(() => runWorker(operation))
    }
  }).pipe(Effect.forever)

const sendPendingResults = (
  writer: (chunk: string) => Effect.Effect<void, Socket.SocketError>,
  session: LocalSession,
  receipts: ReadonlyArray<PendingResult>,
) =>
  Effect.forEach(
    receipts,
    (pending) =>
      pending.response === undefined
        ? Effect.void
        : writer(
            encodeLocalExecutorMessage({
              _tag: "LocalCellResult",
              access: access(session),
              operationKey: pending.operationKey,
              attempt: pending.attempt,
              response: pending.response,
            }),
          ).pipe(Effect.mapError(() => failure("Could not resend local cell result"))),
    { discard: true },
  )

const connected = (
  options: ForegroundLocalExecutorOptions,
  url: string,
  processIncarnation: string,
  sessions: Ref.Ref<LocalSession | undefined>,
  receipts: Ref.Ref<Map<string, PendingResult>>,
  liveOperations: Ref.Ref<Set<string>>,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  cells: Cells["Service"],
  persist: () => Effect.Effect<void, ForegroundLocalExecutorError>,
  runWorker: (effect: Effect.Effect<void, ForegroundLocalExecutorError>) => void,
) =>
  Effect.gen(function* () {
    const previous = yield* Ref.get(sessions)
    const socket = yield* Socket.makeWebSocket(url)
    const writer = yield* socket.writer
    const incoming = yield* Queue.make<IncomingMessage>()
    const reader = yield* socket
      .runString((frame) =>
        decodeApiMessage(frame).pipe(
          Effect.mapError(() => failure("Controller sent an invalid local executor frame")),
          Effect.flatMap((message) => Queue.offer(incoming, message)),
        ),
      )
      .pipe(Effect.forkScoped)
    if (previous === undefined) {
      const admission = options.admission
      if (admission === undefined) return yield* failure("Local executor admission is unavailable")
      yield* writer(
        encodeLocalExecutorMessage({
          _tag: "LocalExecutorHello",
          hello: {
            admissionId: admission.admissionId,
            ticket: admission.ticket,
            processIncarnation,
            capabilities: localCapabilities,
            cursors: initialCursors,
          },
        }),
      ).pipe(Effect.mapError(() => failure("Could not write local executor hello")))
    } else {
      yield* writer(
        encodeLocalExecutorMessage({ _tag: "ExecutorReconnect", access: access(previous) }),
      ).pipe(Effect.mapError(() => failure("Could not write local executor reconnect")))
    }
    const session =
      previous === undefined
        ? yield* Effect.raceFirst(
            waitForWelcome(incoming, processIncarnation),
            Fiber.join(reader).pipe(
              Effect.flatMap(() => failure("Local executor controller connection closed before welcome")),
              Effect.catch(() => failure("Local executor controller connection failed before welcome")),
            ),
          ).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => failure("Local executor controller did not welcome the executor"),
            }),
          )
        : yield* Effect.raceFirst(
            waitForReconnect(incoming, previous, processIncarnation),
            Fiber.join(reader).pipe(
              Effect.flatMap(() => failure("Local executor controller connection closed before reconnect")),
              Effect.catch(() => failure("Local executor controller connection failed before reconnect")),
            ),
          ).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => failure("Local executor controller did not accept the reconnect"),
            }),
          )
    yield* Ref.set(sessions, session)
    yield* Ref.set(activeWriter, writer)
    yield* persist()
    if (options.ready !== undefined) yield* Deferred.succeed(options.ready, undefined)
    if (previous !== undefined) yield* sendPendingResults(writer, session, [...(yield* Ref.get(receipts)).values()])
    const heartbeat = Effect.sleep(session.heartbeatIntervalMillis).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions)
          if (current === undefined) return
          yield* writer(
            encodeLocalExecutorMessage({
              _tag: "ExecutorHeartbeat",
              heartbeat: { version: 1, access: access(current), cursor: current.cursor },
            }),
          ).pipe(Effect.mapError(() => failure("Could not write local executor heartbeat")))
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    )
    yield* heartbeat
    return yield* Effect.raceFirst(
      Fiber.join(reader).pipe(Effect.mapError(() => failure("Local executor controller connection closed"))),
      consumeApi(incoming, writer, sessions, receipts, liveOperations, activeWriter, cells, persist, runWorker),
    )
  })

/**
 * Run one foreground `local_device` executor for the lifetime of the calling
 * scope. It opens one outbound WSS connection, reconnects with the persisted
 * in-process session, and keeps local execution state out of the controller.
 */
export const foregroundLocalExecutorLayer = Layer.merge(BunSocket.layerWebSocketConstructor, BunCrypto.layer)

export const runForegroundLocalExecutor = (
  options: ForegroundLocalExecutorOptions,
): Effect.Effect<void, ForegroundLocalExecutorError, Crypto.Crypto | Socket.WebSocketConstructor> =>
  Effect.scoped(
    Effect.gen(function* () {
      const source = options.resume?.executorUrl ?? options.admission?.executorUrl
      if (source === undefined) return yield* failure("Local executor endpoint is unavailable")
      const url = yield* localExecutorUrl(
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
      const initialReceipts = new Map<string, PendingResult>(
        (options.resume?.receipts ?? []).map((receipt) => [
          receipt.operationKey,
          {
            operationKey: receipt.operationKey,
            attempt: receipt.attempt,
            state: "completed" as const,
            response: receipt.response ?? unknownResponse,
          },
        ]),
      )
      const receipts = yield* Ref.make(initialReceipts)
      const liveOperations = yield* Ref.make(new Set<string>())
      const activeWriter = yield* Ref.make<
        ((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined
      >(undefined)
      const workspaceIdentity = options.resume?.workspaceIdentity ?? options.admission?.workspaceIdentity
      if (workspaceIdentity === undefined) return yield* failure("Local executor workspace identity is unavailable")
      const receiptStore = options.receiptStore
      const receiptScope = options.receiptScope
      const persistLock = yield* Semaphore.make(1)
      const persist = () =>
        persistLock.withPermits(1)(
          receiptStore === undefined || receiptScope === undefined
            ? Effect.void
            : Effect.gen(function* () {
              const session = yield* Ref.get(sessions)
              if (session === undefined) return
              const values = yield* Ref.get(receipts)
              const storedReceipts = [...values.values()].map((receipt) =>
                receipt.response === undefined
                  ? {
                      operationKey: receipt.operationKey,
                      attempt: receipt.attempt,
                      state: receipt.state,
                    }
                  : {
                      operationKey: receipt.operationKey,
                      attempt: receipt.attempt,
                      state: receipt.state,
                      response: receipt.response,
                    },
              )
              yield* receiptStore.save(receiptScope, {
                version: 1,
                workspaceIdentity,
                executorUrl: url,
                access: access(session),
                leaseExpiresAt: session.leaseExpiresAt,
                heartbeatIntervalMillis: session.heartbeatIntervalMillis,
                cursor: session.cursor,
                receipts: storedReceipts,
              })
            }),
        )
      const cells = yield* inMemoryCells(workspaceIdentity, options.workspacePath)
      const workers = yield* FiberSet.make<unknown, unknown>()
      const runWorker = yield* FiberSet.runtime(workers)<never>()
      const connection = connected(
        options,
        url,
        processIncarnation,
        sessions,
        receipts,
        liveOperations,
        activeWriter,
        cells,
        persist,
        runWorker,
      ).pipe(
        Effect.catch((error: ForegroundLocalExecutorError) =>
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
        Effect.ensuring(
          Effect.gen(function* () {
            const session = yield* Ref.get(sessions)
            const writer = yield* Ref.get(activeWriter)
            if (session === undefined || writer === undefined) return
            yield* writer(
              encodeLocalExecutorMessage({ _tag: "LocalExecutorGoodbye", access: access(session) }),
            ).pipe(Effect.ignore)
          }),
        ),
      )
    }),
  )
