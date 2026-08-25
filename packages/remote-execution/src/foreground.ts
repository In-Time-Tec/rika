import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { BunFileSystem } from "@effect/platform-bun"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import type { WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import {
  Cause,
  Clock,
  Config,
  Context,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  FileSystem,
  Layer,
  Queue,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { BindingProxyError, type Transport as BindingTransport } from "./binding-proxy"
import { CellError, State as CellStateSchema, terminalOutcome, type State as CellState } from "./cells"
import * as HostedKernel from "./hosted-kernel"
import { Machine, MachineError, State as MachineState, workspaceLayer as machineLayer } from "./machine"
import {
  AccessWire,
  ApiMessage,
  CellAttribution,
  CellLifecycleFrame,
  CellResponse,
  type ApiMessage as IncomingMessage,
  type CellRequest,
  emptyCursor,
  type Fence,
  RunnerAdmissionWire,
  RunnerMessage,
  type ResumeCursors,
  type WelcomeWire,
} from "./protocol"
import { inspectWorkspaceCapabilities } from "./workspace-capabilities"

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

const ReceiptState = Schema.Literals(["running", "completed"])
const ForegroundReceipt = Schema.Struct({
  operationKey: Schema.String.check(Schema.isMinLength(1)),
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  attribution: CellAttribution,
  frames: Schema.Array(CellLifecycleFrame),
  state: ReceiptState,
  response: Schema.optionalKey(CellResponse),
})
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

const attribution = (request: CellRequest): CellAttribution => ({
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

const executionKey = (operationKey: string, attempt: number) => `${operationKey}\u0000${attempt}`

const redactOutput = (text: string) => {
  const redacted = text
    .replace(/(token|password|secret|authorization)["']?\s*[:=]\s*["'][^"']+/gi, "$1=REDACTED")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "REDACTED")
  return { text: redacted.slice(0, 16_384), truncated: redacted.length > 16_384 }
}

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

interface PendingResult {
  readonly operationKey: string
  readonly attempt: number
  readonly attribution: CellAttribution
  readonly frames: ReadonlyArray<CellLifecycleFrame>
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

const resolveCellResponse = Effect.fn("ForegroundRunner.resolveCellResponse")(function* (input: {
  readonly current: LocalSession
  readonly request: CellRequest
  readonly cells: HostedKernel.Interface
  readonly output: (chunk: { readonly stream: "stdout" | "stderr"; readonly text: string }) => Effect.Effect<void>
}) {
  return sameAccess(access(input.current), input.request.access)
    ? yield* input.cells.execute(input.request, input.output).pipe(
        Effect.catch((error) =>
          Effect.succeed<CellResponse>({
            _tag: "DomainFailure",
            failure: { kind: error._tag === "CellError" ? error.kind : "execution", message: error.message },
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed<CellResponse>({
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
  liveOperations: Ref.Ref<Map<string, Fiber.Fiber<void, ForegroundRunnerError>>>,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  cells: HostedKernel.Interface,
  machine: Machine["Service"],
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
  lifecycle: Semaphore.Semaphore,
  runWorker: (effect: Effect.Effect<void, ForegroundRunnerError>) => Fiber.Fiber<void, ForegroundRunnerError>,
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
    const writeLifecycle = (frame: CellLifecycleFrame) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(session)
        if (current === undefined) return yield* failure("Runner session is unavailable")
        const currentWriter = (yield* Ref.get(activeWriter)) ?? writer
        yield* currentWriter(encodeRunnerMessage({ _tag: "CellLifecycle", access: access(current), frame })).pipe(
          Effect.mapError(() => failure("Could not write local cell lifecycle")),
        )
      })
    const append = (operationKey: string, frame: CellLifecycleFrame, terminal?: { readonly response: CellResponse }) =>
      lifecycle.withPermits(1)(
        Effect.gen(function* () {
          const receipt = (yield* Ref.get(receipts)).get(operationKey)
          if (receipt === undefined || receipt.frames.some((known) => known._tag === "Terminal")) return false
          if (frame.cursor !== receipt.frames.length + 1) return false
          yield* Ref.update(receipts, (values) => {
            const next = new Map(values)
            next.set(operationKey, {
              ...receipt,
              frames: [...receipt.frames, frame],
              ...(terminal === undefined ? {} : { state: "completed" as const, response: terminal.response }),
            })
            return next
          })
          yield* persist()
          yield* writeLifecycle(frame)
          return true
        }),
      )
    if (message._tag === "LocalCellReceipt") {
      const current = yield* Ref.get(session)
      if (current === undefined) return yield* failure("Runner session is unavailable")
      if (!sameAccess(access(current), message.access)) return yield* failure("Runner result receipt is stale")
      const key = executionKey(message.operationKey, message.attempt)
      yield* Ref.update(receipts, (values) => {
        const pending = values.get(key)
        if (pending === undefined || pending.attempt !== message.attempt) return values
        const next = new Map(values)
        next.delete(key)
        return next
      })
      yield* persist()
    }
    if (message._tag === "CellTerminalReceipt") {
      const receipt = (yield* Ref.get(receipts)).get(executionKey(message.operationKey, message.attempt))
      const terminal = receipt?.frames.find(
        (frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }> =>
          frame._tag === "Terminal" && frame.cursor === message.cursor && frame.attribution.attempt === message.attempt,
      )
      const current = yield* Ref.get(session)
      if (terminal !== undefined && current !== undefined && sameAccess(access(current), message.access)) {
        const currentWriter = (yield* Ref.get(activeWriter)) ?? writer
        yield* currentWriter(
          encodeRunnerMessage({
            _tag: "LocalCellResult",
            access: access(current),
            operationKey: message.operationKey,
            attempt: message.attempt,
            response: terminal.response,
          }),
        ).pipe(Effect.mapError(() => failure("Could not write local cell result")))
      }
    }
    if (message._tag === "CellTerminalSuperseded") {
      const current = yield* Ref.get(session)
      if (current === undefined || !sameAccess(access(current), message.access))
        return yield* failure("Runner terminal supersession is stale")
    }
    if (message._tag === "CellReplay") {
      const receipt = (yield* Ref.get(receipts)).get(executionKey(message.operationKey, message.attempt))
      const current = yield* Ref.get(session)
      if (current === undefined || !sameAccess(access(current), message.access))
        return yield* failure("Runner replay has a stale session")
      if (receipt !== undefined)
        yield* Effect.forEach(
          receipt.frames.filter((frame) => frame.cursor > message.afterCursor),
          writeLifecycle,
          { discard: true },
        )
      yield* cells.replayBindings(access(current)).pipe(Effect.mapError((error) => failure(error.message)))
    }
    if (message._tag === "CellCancel") {
      const current = yield* Ref.get(session)
      if (current === undefined || !sameAccess(access(current), message.access))
        return yield* failure("Runner cancellation has a stale session")
      const key = executionKey(message.operationKey, message.attempt)
      const receipt = (yield* Ref.get(receipts)).get(key)
      if (receipt === undefined || receipt.attempt !== message.attempt)
        return yield* failure("Runner cancellation has a stale attempt")
      const response = yield* cells
        .cancel(message.operationKey, message.attempt)
        .pipe(Effect.mapError((error) => failure(error.message)))
      const interrupted = (yield* Ref.get(receipts)).get(key)
      if (interrupted !== undefined && !interrupted.frames.some((frame) => frame._tag === "Terminal")) {
        yield* append(
          key,
          {
            _tag: "Terminal",
            attribution: interrupted.attribution,
            cursor: interrupted.frames.length + 1,
            outcome: terminalOutcome(response),
            response,
          },
          { response },
        )
      }
    }
    if (message._tag === "BindingResult") {
      const current = yield* Ref.get(session)
      if (current === undefined || !sameAccess(access(current), message.access))
        return yield* failure("Local binding result has a stale session")
      yield* cells.completeBinding(message).pipe(Effect.mapError((error) => failure(error.message)))
    }
    if (message._tag === "MachineExecute") {
      const current = yield* Ref.get(session)
      if (current === undefined || !sameAccess(access(current), message.access))
        return yield* failure("Local machine request has a stale session")
      yield* Effect.sync(() =>
        runWorker(
          machine
            .execute({
              machineId: message.machineId,
              requestDigest: message.requestDigest,
              request: message.request,
            })
            .pipe(
              Effect.flatMap((outcome) =>
                Effect.gen(function* () {
                  const latest = yield* Ref.get(session)
                  const currentWriter = yield* Ref.get(activeWriter)
                  if (latest === undefined || currentWriter === undefined) return
                  yield* currentWriter(
                    encodeRunnerMessage({
                      _tag: "MachineResult",
                      access: access(latest),
                      operationKey: message.operationKey,
                      attempt: message.attempt,
                      machineId: message.machineId,
                      requestDigest: message.requestDigest,
                      outcome,
                    }),
                  ).pipe(Effect.mapError(() => failure("Could not write local machine result")))
                }),
              ),
              Effect.mapError((error) => failure(error.message)),
            ),
        ),
      )
    }
    if (message._tag === "CellExecute") {
      const current = yield* Ref.get(session)
      if (current === undefined) return yield* failure("Runner session is unavailable")
      const operationKey = message.request.operationKey
      const attempt = message.request.attempt
      const key = executionKey(operationKey, attempt)
      const known = (yield* Ref.get(receipts)).get(key)
      if (known !== undefined && attempt < known.attempt) return
      if (known !== undefined && (known.state !== "running" || (yield* Ref.get(liveOperations)).has(key))) {
        yield* Effect.forEach(known.frames, writeLifecycle, { discard: true })
        yield* cells.replayBindings(access(current)).pipe(Effect.mapError((error) => failure(error.message)))
        return
      }
      const identity = known?.attribution ?? attribution(message.request)
      if (known === undefined) {
        const accepted: CellLifecycleFrame = { _tag: "Accepted", attribution: identity, cursor: 1 }
        yield* Ref.update(receipts, (values) =>
          new Map(values).set(key, {
            operationKey,
            attempt,
            attribution: identity,
            frames: [accepted],
            state: "running",
          }),
        )
        yield* persist()
        yield* writeLifecycle(accepted)
      }
      const admission = yield* cells.admit(message.request).pipe(
        Effect.match({
          onFailure: (error) =>
            ({
              _tag: "Failure" as const,
              response: {
                _tag: "DomainFailure" as const,
                failure: { kind: error._tag === "CellError" ? error.kind : "execution", message: error.message },
              },
            }) satisfies { readonly _tag: "Failure"; readonly response: CellResponse },
          onSuccess: () => ({ _tag: "Success" as const }),
        }),
      )
      if (admission._tag === "Failure") {
        const receipt = (yield* Ref.get(receipts)).get(key)
        if (receipt !== undefined)
          yield* append(
            key,
            {
              _tag: "Terminal",
              attribution: identity,
              cursor: receipt.frames.length + 1,
              outcome: terminalOutcome(admission.response),
              response: admission.response,
            },
            { response: admission.response },
          )
        return
      }
      const admittedReceipt = (yield* Ref.get(receipts)).get(key)
      if (admittedReceipt !== undefined && !admittedReceipt.frames.some((frame) => frame._tag === "Started"))
        yield* append(key, {
          _tag: "Started",
          attribution: identity,
          cursor: admittedReceipt.frames.length + 1,
        })
      const operation = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const response = yield* restore(
            resolveCellResponse({
              current,
              request: message.request,
              cells,
              output: (chunk) =>
                Effect.gen(function* () {
                  const receipt = (yield* Ref.get(receipts)).get(key)
                  if (receipt === undefined || receipt.frames.filter((frame) => frame._tag === "Output").length >= 16)
                    return
                  const output = redactOutput(chunk.text)
                  yield* append(key, {
                    _tag: "Output",
                    attribution: identity,
                    cursor: receipt.frames.length + 1,
                    stream: chunk.stream,
                    text: output.text,
                    redacted: true,
                    truncated: output.truncated,
                  }).pipe(Effect.ignore)
                }),
            }),
          )
          const receipt = (yield* Ref.get(receipts)).get(key)
          if (receipt === undefined) return
          yield* append(
            key,
            {
              _tag: "Terminal",
              attribution: identity,
              cursor: receipt.frames.length + 1,
              outcome: terminalOutcome(response),
              response,
            },
            { response },
          )
        }),
      ).pipe(
        Effect.ensuring(
          Ref.update(liveOperations, (values) => {
            const next = new Map(values)
            next.delete(key)
            return next
          }),
        ),
      )
      const gate = yield* Deferred.make<void>()
      const fiber = yield* Effect.sync(() => runWorker(Deferred.await(gate).pipe(Effect.andThen(operation))))
      yield* Ref.update(liveOperations, (values) => new Map(values).set(key, fiber))
      yield* Deferred.succeed(gate, undefined)
    }
  }).pipe(Effect.forever)

const connected = (
  options: ForegroundRunnerOptions,
  url: string,
  processIncarnation: string,
  workspaceCapabilities: WorkspaceCapabilitySnapshot,
  sessions: Ref.Ref<LocalSession | undefined>,
  receipts: Ref.Ref<Map<string, PendingResult>>,
  liveOperations: Ref.Ref<Map<string, Fiber.Fiber<void, ForegroundRunnerError>>>,
  activeWriter: Ref.Ref<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>,
  cells: HostedKernel.Interface,
  machine: Machine["Service"],
  persist: () => Effect.Effect<void, ForegroundRunnerError>,
  lifecycle: Semaphore.Semaphore,
  runWorker: (effect: Effect.Effect<void, ForegroundRunnerError>) => Fiber.Fiber<void, ForegroundRunnerError>,
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
      }).pipe(
        Effect.forever,
      )
      return yield* Effect.raceFirst(
        Fiber.join(reader).pipe(Effect.mapError(() => failure("Runner controller connection closed"))),
        Effect.raceFirst(
          consumeApi(
            incoming,
            writer,
            sessions,
            receipts,
            liveOperations,
            activeWriter,
            cells,
            machine,
            persist,
            lifecycle,
            runWorker,
          ),
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
      const initialReceipts = new Map<string, PendingResult>(
        (options.resume?.receipts ?? []).map((receipt) => [
          executionKey(receipt.operationKey, receipt.attempt),
          receipt,
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
      const liveOperations = yield* Ref.make(new Map<string, Fiber.Fiber<void, ForegroundRunnerError>>())
      const activeWriter = yield* Ref.make<((chunk: string) => Effect.Effect<void, Socket.SocketError>) | undefined>(
        undefined,
      )
      const workspaceIdentity = options.resume?.workspaceIdentity ?? options.admission?.workspaceIdentity
      if (workspaceIdentity === undefined) return yield* failure("Runner Workspace identity is unavailable")
      const receiptStore = options.receiptStore
      const receiptScope = options.receiptScope
      const persistLock = yield* Semaphore.make(1)
      const lifecycle = yield* Semaphore.make(1)
      const persist = () =>
        persistLock.withPermits(1)(
          receiptStore === undefined || receiptScope === undefined
            ? Effect.void
            : Effect.gen(function* () {
                const session = yield* Ref.get(sessions)
                if (session === undefined) return
                const values = yield* Ref.get(receipts)
                const storedReceipts = [...values.values()]
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
              }),
        )
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
      const workspaceCapabilities = yield* inspectWorkspaceCapabilities({
        target: "runner",
        workspacePath: options.workspacePath,
        typescriptKernel: true,
        pty: false,
      })
      const workers = yield* FiberSet.make<void, ForegroundRunnerError>()
      const runWorker = yield* FiberSet.runtime(workers)<never>()
      const connection = connected(
        options,
        url,
        processIncarnation,
        workspaceCapabilities,
        sessions,
        receipts,
        liveOperations,
        activeWriter,
        cells,
        machine,
        persist,
        lifecycle,
        runWorker,
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
