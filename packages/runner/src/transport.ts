/* oxlint-disable effecttsgo/missing-pipeable-signature, effecttsgo/lazy-effect -- callable WebSocket lifecycle methods are transport boundaries. */

import {
  ExecutorFenceError,
  ExecutorTransportError,
  WorkspaceExecutorServerFrame,
  WorkspaceExecutorRunnerFrame,
  bindingMismatchReason,
  defaultWorkspaceExecutorTransportLimits,
  sameEvidence,
  workspaceExecutorWebSocketProtocol,
  type WorkspaceExecutorRpcRequest,
  type WorkspaceExecutorRpcResponse,
  type WorkspaceExecutorService,
  type WorkspaceExecutorTransportLimits,
  type WorkspaceExecutorWebSocketData,
  type WorkspaceExecutorWebSocketPeer,
} from "@rika/execution"
import { Cause, Deferred, Effect, FiberSet, Option, Ref, Schema, Scope, Semaphore } from "effect"

export interface RunnerWebSocketClientOptions {
  readonly workspace: WorkspaceExecutorService
  readonly peer: WorkspaceExecutorWebSocketPeer
  readonly limits?: Partial<WorkspaceExecutorTransportLimits>
}

export interface RunnerWebSocketClient {
  readonly opened: () => Effect.Effect<void, ExecutorTransportError | ExecutorFenceError>
  readonly ready: Effect.Effect<void, ExecutorTransportError | ExecutorFenceError>
  readonly receive: (
    frame: WorkspaceExecutorWebSocketData,
  ) => Effect.Effect<void, ExecutorTransportError | ExecutorFenceError>
  readonly disconnected: () => Effect.Effect<void>
}

export interface ConnectRunnerWebSocketOptions {
  readonly workspace: WorkspaceExecutorService
  readonly connect: () => globalThis.WebSocket
  readonly limits?: Partial<WorkspaceExecutorTransportLimits>
}

export interface RunnerWebSocketConnection {
  readonly socket: globalThis.WebSocket
  readonly ready: RunnerWebSocketClient["ready"]
  readonly closed: Effect.Effect<void>
  readonly close: () => Effect.Effect<void>
}

interface ActiveRpc {
  readonly bytes: number
}

const encodeRunnerFrame = Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))
const decodeServerFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceExecutorServerFrame))

const transport = (phase: ExecutorTransportError["phase"], message: string) =>
  ExecutorTransportError.make({ phase, message })

const fenced = (reason: ExecutorFenceError["reason"], message: string) =>
  ExecutorFenceError.make({ reason, message })

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const frameText = (
  frame: WorkspaceExecutorWebSocketData,
  maximum: number,
): Effect.Effect<{ readonly bytes: number; readonly text: string }, ExecutorTransportError> =>
  Effect.try({
    try: () => {
      if (Schema.is(Schema.String)(frame)) {
        const bytes = byteLength(frame)
        if (bytes > maximum) throw new Error("oversized")
        return { bytes, text: frame }
      }
      const encoded = frame instanceof ArrayBuffer
        ? new Uint8Array(frame)
        : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
      if (encoded.byteLength > maximum) throw new Error("oversized")
      return { bytes: encoded.byteLength, text: new TextDecoder("utf-8", { fatal: true }).decode(encoded) }
    },
    catch: () => transport("connection", "Workspace Executor WebSocket frame is invalid or exceeds the byte limit"),
  })

const resolveLimits = (
  input: Partial<WorkspaceExecutorTransportLimits> | undefined,
): Effect.Effect<WorkspaceExecutorTransportLimits, ExecutorTransportError> => {
  const limits = { ...defaultWorkspaceExecutorTransportLimits, ...input }
  return Number.isSafeInteger(limits.maxFrameBytes) &&
    Number.isSafeInteger(limits.maxInFlightRpcs) &&
    Number.isSafeInteger(limits.maxInFlightBytes) &&
    limits.maxFrameBytes >= defaultWorkspaceExecutorTransportLimits.maxFrameBytes &&
    limits.maxInFlightRpcs >= 1 &&
    limits.maxInFlightRpcs <= 128 &&
    limits.maxInFlightBytes >= limits.maxFrameBytes &&
    limits.maxInFlightBytes <= 16 * 1024 * 1024
    ? Effect.succeed(limits)
    : Effect.fail(transport("connection", "Runner WebSocket transport limits are invalid"))
}

const phaseFor = (request: WorkspaceExecutorRpcRequest): ExecutorTransportError["phase"] => {
  switch (request._tag) {
    case "Handshake":
      return "handshake"
    case "Dispatch":
      return "after-dispatch"
    case "Receipt":
      return "receipt"
    case "Cancel":
      return "cancel"
  }
}

const executeRequest = (
  workspace: WorkspaceExecutorService,
  request: WorkspaceExecutorRpcRequest,
): Effect.Effect<WorkspaceExecutorRpcResponse, ExecutorTransportError | ExecutorFenceError> => {
  switch (request._tag) {
    case "Handshake":
      return workspace.handshake(request.request).pipe(
        Effect.map((evidence) => ({ _tag: "HandshakeResult" as const, evidence })),
      )
    case "Dispatch":
      return workspace.dispatch(request.intent, request.input, request.handshake).pipe(
        Effect.map((evidence) => ({ _tag: "DispatchResult" as const, evidence })),
      )
    case "Receipt":
      return workspace.receipt(request.operationId).pipe(
        Effect.map((evidence) => ({ _tag: "ReceiptResult" as const, evidence: evidence ?? null })),
      )
    case "Cancel":
      return workspace.cancel(request.operationId).pipe(
        Effect.map((cancellation) => ({ _tag: "CancelResult" as const, cancellation })),
      )
  }
}

const makeClient = (
  options: RunnerWebSocketClientOptions,
): Effect.Effect<RunnerWebSocketClient, ExecutorTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const limits = yield* resolveLimits(options.limits)
    const ownerScope = yield* Effect.scope
    const state = yield* Ref.make<"created" | "awaiting-enrollment" | "ready" | "closed">("created")
    const active = yield* Ref.make(new Map<string, ActiveRpc>())
    const ready = yield* Deferred.make<void, ExecutorTransportError | ExecutorFenceError>()
    const lock = yield* Semaphore.make(1)

    const close = (code: number, reason: string) =>
      Effect.try({
        try: () => options.peer.close(code, reason),
        catch: () => transport("connection", "Workspace Executor WebSocket close failed"),
      }).pipe(Effect.ignore)

    const send = (frame: WorkspaceExecutorRunnerFrame) =>
      encodeRunnerFrame(frame).pipe(
        Effect.mapError(() => transport("connection", "Runner response could not be encoded")),
        Effect.flatMap((encoded) =>
          byteLength(encoded) > limits.maxFrameBytes
            ? Effect.fail(transport("after-dispatch", "Runner response exceeds the WebSocket byte limit"))
            : Effect.try({
                try: () => options.peer.send(encoded),
                catch: () => transport("connection", "Workspace Executor WebSocket send failed"),
              }),
        ),
      )

    const disconnected = () =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(state)) === "closed") return
          yield* Ref.set(state, "closed")
          yield* Deferred.fail(ready, transport("connection", "Workspace Executor WebSocket disconnected"))
        }),
      )

    const rejectConnection = (
      error: ExecutorTransportError | ExecutorFenceError,
    ): Effect.Effect<never, ExecutorTransportError | ExecutorFenceError> =>
      disconnected().pipe(
        Effect.andThen(close(1008, "workspace executor connection rejected")),
        Effect.andThen(Effect.fail(error)),
      )

    const opened = () =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(state)) !== "created")
            return yield* fenced("protocol", "Runner WebSocket was opened more than once")
          yield* Ref.set(state, "awaiting-enrollment")
          yield* send({ _tag: "Enroll", binding: options.workspace.binding })
        }),
      )

    const complete = (id: string) =>
      lock.withPermits(1)(
        Ref.update(active, (current) => {
          if (!current.has(id)) return current
          const next = new Map(current)
          next.delete(id)
          return next
        }),
      )

    const handle = (id: string, request: WorkspaceExecutorRpcRequest) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.exit(executeRequest(options.workspace, request))
        if (outcome._tag === "Success") {
          yield* send({ _tag: "Response", id, response: outcome.value })
          return
        }
        const candidate = Option.getOrUndefined(Cause.findErrorOption(outcome.cause))
        const error =
          candidate !== undefined &&
          (Schema.is(ExecutorTransportError)(candidate) || Schema.is(ExecutorFenceError)(candidate))
            ? candidate
            : transport(phaseFor(request), "Runner request failed without typed Executor evidence")
        yield* send({ _tag: "Failure", id, error })
      }).pipe(
        Effect.catch((error) =>
          disconnected().pipe(Effect.andThen(close(1011, "workspace executor response failed")), Effect.as(error)),
        ),
        Effect.ensuring(complete(id)),
        Effect.asVoid,
      )

    const receive = Effect.fn("RikaRunnerV2.WorkspaceExecutorTransport.receive")(function* (
      value: WorkspaceExecutorWebSocketData,
    ) {
      const decoded = yield* frameText(value, limits.maxFrameBytes).pipe(
        Effect.catch((error) => rejectConnection(error)),
      )
      const frame = yield* decodeServerFrame(decoded.text).pipe(
        Effect.mapError(() => fenced("protocol", "Workspace Executor WebSocket frame does not match the protocol")),
        Effect.catch((error) => rejectConnection(error)),
      )
      if (frame._tag === "Enrolled") {
        if ((yield* Ref.get(state)) !== "awaiting-enrollment")
          return yield* rejectConnection(fenced("protocol", "Workspace Executor sent duplicate enrollment evidence"))
        if (!sameEvidence(options.workspace.binding, frame.binding))
          return yield* rejectConnection(
            fenced(
              bindingMismatchReason(options.workspace.binding, frame.binding) ?? "generation",
              "Workspace Executor enrollment evidence does not match the local assignment",
            ),
          )
        yield* Ref.set(state, "ready")
        yield* Deferred.succeed(ready, undefined)
        return
      }
      if ((yield* Ref.get(state)) !== "ready")
        return yield* rejectConnection(fenced("protocol", "Workspace Executor sent an RPC before enrollment"))
      const accepted = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(active)
          let bytes = 0
          for (const operation of current.values()) bytes += operation.bytes
          if (current.has(frame.id)) return false
          if (current.size >= limits.maxInFlightRpcs || bytes + decoded.bytes > limits.maxInFlightBytes) return false
          yield* Ref.set(active, new Map(current).set(frame.id, { bytes: decoded.bytes }))
          return true
        }),
      )
      if (!accepted)
        return yield* rejectConnection(fenced("protocol", "Workspace Executor RPC capacity or identity was rejected"))
      yield* Effect.forkIn(handle(frame.id, frame.request), ownerScope)
    })

    return yield* Effect.acquireRelease(
      Effect.succeed({ opened, ready: Deferred.await(ready), receive, disconnected }),
      (client) => client.disconnected(),
    )
  })

export const makeRunnerWebSocketClient = makeClient

export const connectRunnerWebSocket = (
  options: ConnectRunnerWebSocketOptions,
): Effect.Effect<RunnerWebSocketConnection, ExecutorTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* Effect.try({
      try: options.connect,
      catch: () => transport("connection", "Runner WebSocket construction failed"),
    })
    socket.binaryType = "arraybuffer"
    const clientOptions: RunnerWebSocketClientOptions = {
      workspace: options.workspace,
      peer: {
        send: (frame) => socket.send(frame),
        close: (code, reason) => socket.close(code, reason),
      },
    }
    if (options.limits !== undefined) Object.assign(clientOptions, { limits: options.limits })
    const client = yield* makeRunnerWebSocketClient(clientOptions)
    const closed = yield* Deferred.make<void>()
    const fibers = yield* FiberSet.make<void, never>()
    const run = yield* FiberSet.runtime(fibers)<never>()
    const receiveGate = yield* Semaphore.make(1)
    const failConnection = (error: ExecutorTransportError | ExecutorFenceError) =>
      client.disconnected().pipe(
        Effect.andThen(
          Effect.sync(() => {
            socket.close(1008, error.message)
          }),
        ),
      )
    const onOpen = () => {
      if (socket.protocol !== workspaceExecutorWebSocketProtocol) {
        fenced("protocol", "Runner WebSocket subprotocol was not negotiated").pipe(failConnection, run)
        return
      }
      run(client.opened().pipe(Effect.catch(failConnection), Effect.asVoid))
    }
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame =
        Schema.is(Schema.String)(event.data) || event.data instanceof ArrayBuffer ? event.data : undefined
      if (frame === undefined) {
        fenced("protocol", "Runner WebSocket received an unsupported frame type").pipe(failConnection, run)
        return
      }
      run(receiveGate.withPermits(1)(client.receive(frame)).pipe(Effect.catch(failConnection), Effect.asVoid))
    }
    const onClose = () => {
      run(client.disconnected().pipe(Effect.andThen(Deferred.succeed(closed, undefined))))
    }
    const onError = () => {
      run(client.disconnected())
    }
    socket.addEventListener("open", onOpen)
    socket.addEventListener("message", onMessage)
    socket.addEventListener("close", onClose)
    socket.addEventListener("error", onError)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        socket.removeEventListener("open", onOpen)
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("close", onClose)
        socket.removeEventListener("error", onError)
        if (socket.readyState === globalThis.WebSocket.OPEN) socket.close(1000, "runner transport closed")
      }).pipe(Effect.andThen(client.disconnected())),
    )
    return {
      socket,
      ready: client.ready,
      closed: Deferred.await(closed),
      close: () =>
        Effect.sync(() => socket.close(1000, "runner transport closed")).pipe(
          Effect.andThen(client.disconnected()),
        ),
    }
  })

export const RunnerExecutorTransport = {
  connect: connectRunnerWebSocket,
  makeClient: makeRunnerWebSocketClient,
}
