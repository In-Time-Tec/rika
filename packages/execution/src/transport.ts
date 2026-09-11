/* oxlint-disable effecttsgo/missing-pipeable-signature, effecttsgo/lazy-effect, effecttsgo/effect-succeed-with-void -- callable socket lifecycle, authorization closures, and optional receipt values are transport boundaries. */

import { Deferred, Effect, Ref, Schema, Scope, Semaphore } from "effect"
import { Pins } from "generalist"

import { WorkspaceBinding, bindingMismatchReason, sameBinding, sameEvidence, toEvidence } from "./binding"
import {
  ExecutorEvidence,
  ExecutorFenceError,
  ExecutorTransportError,
  HandshakeEvidence,
  HandshakeRequest,
  maxDispatchBytes,
  maxReceiptBytes,
  validateEvidence,
  validateHandshake,
  type WorkspaceExecutorService,
} from "./executor"
import { ExecutorCancellation, NativeOperationIntent } from "./operation"

const RpcId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const OperationId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))

export const WorkspaceExecutorRpcRequest = Schema.Union([
  Schema.TaggedStruct("Handshake", { request: HandshakeRequest }),
  Schema.TaggedStruct("Dispatch", {
    intent: NativeOperationIntent,
    input: Schema.Json,
    handshake: HandshakeEvidence,
  }),
  Schema.TaggedStruct("Receipt", { operationId: OperationId }),
  Schema.TaggedStruct("Cancel", { operationId: OperationId }),
])
export type WorkspaceExecutorRpcRequest = typeof WorkspaceExecutorRpcRequest.Type

export const WorkspaceExecutorRpcResponse = Schema.Union([
  Schema.TaggedStruct("HandshakeResult", { evidence: HandshakeEvidence }),
  Schema.TaggedStruct("DispatchResult", { evidence: ExecutorEvidence }),
  Schema.TaggedStruct("ReceiptResult", { evidence: Schema.NullOr(ExecutorEvidence) }),
  Schema.TaggedStruct("CancelResult", { cancellation: ExecutorCancellation }),
])
export type WorkspaceExecutorRpcResponse = typeof WorkspaceExecutorRpcResponse.Type

export const WorkspaceExecutorRpcFailure = Schema.Union([ExecutorTransportError, ExecutorFenceError])
export type WorkspaceExecutorRpcFailure = typeof WorkspaceExecutorRpcFailure.Type

export const WorkspaceExecutorServerFrame = Schema.Union([
  Schema.TaggedStruct("Enrolled", { binding: HandshakeEvidence }),
  Schema.TaggedStruct("Request", { id: RpcId, request: WorkspaceExecutorRpcRequest }),
])
export type WorkspaceExecutorServerFrame = typeof WorkspaceExecutorServerFrame.Type

export const WorkspaceExecutorRunnerFrame = Schema.Union([
  Schema.TaggedStruct("Enroll", { binding: WorkspaceBinding }),
  Schema.TaggedStruct("Response", { id: RpcId, response: WorkspaceExecutorRpcResponse }),
  Schema.TaggedStruct("Failure", { id: RpcId, error: WorkspaceExecutorRpcFailure }),
])
export type WorkspaceExecutorRunnerFrame = typeof WorkspaceExecutorRunnerFrame.Type

export type WorkspaceExecutorWebSocketData = string | ArrayBuffer | ArrayBufferView

export interface WorkspaceExecutorWebSocketPeer {
  readonly send: (frame: string) => void
  readonly close: (code: number, reason: string) => void
}

export interface WorkspaceExecutorTransportLimits {
  readonly maxFrameBytes: number
  readonly maxInFlightRpcs: number
  readonly maxInFlightBytes: number
}

export const defaultWorkspaceExecutorTransportLimits: WorkspaceExecutorTransportLimits = {
  maxFrameBytes: maxReceiptBytes + 16_384,
  maxInFlightRpcs: 64,
  maxInFlightBytes: maxDispatchBytes * 64,
}

export const workspaceExecutorWebSocketProtocol = "rika.workspace-executor.v1"

export interface WorkspaceExecutorWebSocketServerOptions<R = never> {
  readonly authorize: () => Effect.Effect<
    WorkspaceBinding,
    ExecutorTransportError | ExecutorFenceError,
    R
  >
  readonly peer: WorkspaceExecutorWebSocketPeer
  readonly limits?: Partial<WorkspaceExecutorTransportLimits>
}

export interface WorkspaceExecutorWebSocketServer {
  readonly executor: WorkspaceExecutorService
  readonly ready: Effect.Effect<HandshakeEvidence, ExecutorTransportError | ExecutorFenceError>
  readonly receive: (
    frame: WorkspaceExecutorWebSocketData,
  ) => Effect.Effect<void, ExecutorTransportError | ExecutorFenceError>
  readonly disconnected: () => Effect.Effect<void>
}

type ResponseTag = WorkspaceExecutorRpcResponse["_tag"]

interface PendingRpc {
  readonly bytes: number
  readonly expected: ResponseTag
  readonly phase: ExecutorTransportError["phase"]
  readonly result: Deferred.Deferred<WorkspaceExecutorRpcResponse, ExecutorTransportError | ExecutorFenceError>
}

const encodeServerFrame = Schema.encodeEffect(Schema.fromJsonString(WorkspaceExecutorServerFrame))
const decodeRunnerFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceExecutorRunnerFrame))

const transport = (phase: ExecutorTransportError["phase"], message: string) =>
  ExecutorTransportError.make({ phase, message })

const fenced = (reason: ExecutorFenceError["reason"], message: string) =>
  ExecutorFenceError.make({ reason, message })

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const frameText = (
  frame: WorkspaceExecutorWebSocketData,
  maximum: number,
): Effect.Effect<string, ExecutorTransportError> =>
  Effect.try({
    try: () => {
      if (Schema.is(Schema.String)(frame)) {
        if (byteLength(frame) > maximum) throw new Error("oversized")
        return frame
      }
      const bytes = frame instanceof ArrayBuffer
        ? new Uint8Array(frame)
        : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
      if (bytes.byteLength > maximum) throw new Error("oversized")
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    },
    catch: () => transport("connection", "Runner WebSocket frame is invalid or exceeds the byte limit"),
  })

const resolveLimits = (
  input: Partial<WorkspaceExecutorTransportLimits> | undefined,
): Effect.Effect<WorkspaceExecutorTransportLimits, ExecutorTransportError> => {
  const limits = { ...defaultWorkspaceExecutorTransportLimits, ...input }
  return Number.isSafeInteger(limits.maxFrameBytes) &&
    Number.isSafeInteger(limits.maxInFlightRpcs) &&
    Number.isSafeInteger(limits.maxInFlightBytes) &&
    limits.maxFrameBytes >= maxReceiptBytes &&
    limits.maxInFlightRpcs >= 1 &&
    limits.maxInFlightRpcs <= 128 &&
    limits.maxInFlightBytes >= limits.maxFrameBytes &&
    limits.maxInFlightBytes <= 16 * 1024 * 1024
    ? Effect.succeed(limits)
    : Effect.fail(transport("connection", "Workspace Executor transport limits are invalid"))
}

const responseTag = (request: WorkspaceExecutorRpcRequest): ResponseTag => {
  switch (request._tag) {
    case "Handshake":
      return "HandshakeResult"
    case "Dispatch":
      return "DispatchResult"
    case "Receipt":
      return "ReceiptResult"
    case "Cancel":
      return "CancelResult"
  }
}

const requestPhase = (request: WorkspaceExecutorRpcRequest): ExecutorTransportError["phase"] => {
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

const makeServer = <R>(
  options: WorkspaceExecutorWebSocketServerOptions<R>,
): Effect.Effect<
  WorkspaceExecutorWebSocketServer,
  ExecutorTransportError | ExecutorFenceError,
  Scope.Scope | R
> =>
  Effect.gen(function* () {
    const limits = yield* resolveLimits(options.limits)
    const authorized = yield* options.authorize()
    const binding = yield* Schema.decodeEffect(WorkspaceBinding)(authorized).pipe(
      Effect.mapError(() => fenced("assignment", "Runner authorization returned an invalid workspace binding")),
    )
    const ready = yield* Deferred.make<HandshakeEvidence, ExecutorTransportError | ExecutorFenceError>()
    const pending = yield* Ref.make(new Map<string, PendingRpc>())
    const retired = yield* Ref.make(new Set<string>())
    const state = yield* Ref.make<"awaiting-enrollment" | "ready" | "closed">("awaiting-enrollment")
    const lock = yield* Semaphore.make(1)
    let nextRpc = 0

    const close = (code: number, reason: string) =>
      Effect.try({
        try: () => options.peer.close(code, reason),
        catch: () => transport("connection", "Runner WebSocket close failed"),
      }).pipe(Effect.ignore)

    const send = (frame: WorkspaceExecutorServerFrame, maximum = limits.maxFrameBytes) =>
      encodeServerFrame(frame).pipe(
        Effect.mapError(() => transport("connection", "Workspace Executor response could not be encoded")),
        Effect.flatMap((encoded) =>
          byteLength(encoded) > maximum
            ? Effect.fail(transport("before-dispatch", "Workspace Executor request exceeds the byte limit"))
            : Effect.try({
                try: () => options.peer.send(encoded),
                catch: () => transport("connection", "Runner WebSocket send failed"),
              }),
        ),
      )

    const shutdown = (error: ExecutorTransportError | ExecutorFenceError) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(state)) === "closed") return []
          yield* Ref.set(state, "closed")
          const current = [...(yield* Ref.get(pending)).values()]
          yield* Ref.set(pending, new Map())
          yield* Deferred.fail(ready, error)
          return current
        }),
      ).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(
            current,
            (entry) =>
              Deferred.fail(
                entry.result,
                Schema.is(ExecutorFenceError)(error) ? error : transport(entry.phase, error.message),
              ),
            { discard: true },
          ),
        ),
      )

    const rejectConnection = (
      error: ExecutorTransportError | ExecutorFenceError,
    ): Effect.Effect<never, ExecutorTransportError | ExecutorFenceError> =>
      shutdown(error).pipe(
        Effect.andThen(close(1008, "workspace executor connection rejected")),
        Effect.andThen(Effect.fail(error)),
      )

    const retire = (id: string, entry: PendingRpc) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(pending)
          if (current.get(id)?.result !== entry.result) return
          const next = new Map(current)
          next.delete(id)
          yield* Ref.set(pending, next)
          const previous = yield* Ref.get(retired)
          const bounded = new Set(previous)
          bounded.add(id)
          while (bounded.size > limits.maxInFlightRpcs * 2) {
            const oldest = bounded.values().next().value
            if (oldest === undefined) break
            bounded.delete(oldest)
          }
          yield* Ref.set(retired, bounded)
        }),
      )

    const rpc = (request: WorkspaceExecutorRpcRequest) =>
      Effect.gen(function* () {
        yield* Deferred.await(ready)
        const id = `rpc:${nextRpc}`
        nextRpc += 1
        const frame = WorkspaceExecutorServerFrame.make({ _tag: "Request", id, request })
        const encoded = yield* encodeServerFrame(frame).pipe(
          Effect.mapError(() => transport("before-dispatch", "Workspace Executor request could not be encoded")),
        )
        const bytes = byteLength(encoded)
        const requestLimit = request._tag === "Dispatch" ? maxDispatchBytes : limits.maxFrameBytes
        if (bytes > requestLimit) return yield* transport("before-dispatch", "Workspace Executor request exceeds the byte limit")
        const entry: PendingRpc = {
          bytes,
          expected: responseTag(request),
          phase: requestPhase(request),
          result: yield* Deferred.make<
            WorkspaceExecutorRpcResponse,
            ExecutorTransportError | ExecutorFenceError
          >(),
        }
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* Ref.get(state)) !== "ready")
              return yield* transport("connection", "Runner WebSocket is not connected")
            const current = yield* Ref.get(pending)
            let currentBytes = 0
            for (const candidate of current.values()) currentBytes += candidate.bytes
            if (current.size >= limits.maxInFlightRpcs || currentBytes + bytes > limits.maxInFlightBytes)
              return yield* transport("before-dispatch", "Workspace Executor RPC capacity is exhausted")
            yield* Ref.set(pending, new Map(current).set(id, entry))
          }),
        )
        const sent = yield* Effect.result(
          Effect.try({
            try: () => options.peer.send(encoded),
            catch: () => transport("before-dispatch", "Runner WebSocket send failed"),
          }),
        )
        if (sent._tag === "Failure") {
          yield* retire(id, entry)
          return yield* sent.failure
        }
        return yield* Deferred.await(entry.result).pipe(Effect.ensuring(retire(id, entry)))
      })

    const executor: WorkspaceExecutorService = {
      binding,
      handshake: (request) => {
        if (!sameBinding(binding, request.binding))
          return Effect.fail(
            fenced(
              bindingMismatchReason(binding, request.binding) ?? "generation",
              "Workspace Executor handshake does not match the authorized binding",
            ),
          )
        return rpc({ _tag: "Handshake", request }).pipe(
          Effect.flatMap((response) =>
            response._tag === "HandshakeResult"
              ? validateHandshake(binding, response.evidence)
              : Effect.fail(fenced("protocol", "Runner returned the wrong handshake response")),
          ),
        )
      },
      dispatch: (intent, input, handshake) => {
        if (!sameBinding(binding, intent.binding))
          return Effect.fail(
            fenced(
              bindingMismatchReason(binding, intent.binding) ?? "generation",
              "Workspace Executor dispatch does not match the authorized binding",
            ),
          )
        if (!sameEvidence(binding, handshake))
          return Effect.fail(
            fenced(
              bindingMismatchReason(binding, handshake) ?? "generation",
              "Workspace Executor dispatch uses stale handshake evidence",
            ),
          )
        if (Pins.digest(input) !== intent.inputDigest)
          return Effect.fail(fenced("input", "Workspace Executor dispatch input digest does not match the intent"))
        return rpc({ _tag: "Dispatch", intent, input, handshake }).pipe(
          Effect.flatMap((response) =>
            response._tag === "DispatchResult"
              ? validateEvidence(intent, response.evidence)
              : Effect.fail(fenced("protocol", "Runner returned the wrong dispatch response")),
          ),
        )
      },
      receipt: (operationId) =>
        rpc({ _tag: "Receipt", operationId }).pipe(
          Effect.flatMap((response) => {
            if (response._tag !== "ReceiptResult")
              return Effect.fail(fenced("protocol", "Runner returned the wrong receipt response"))
            if (response.evidence === null) return Effect.succeed<ExecutorEvidence | undefined>(undefined)
            if (response.evidence.operationId !== operationId)
              return Effect.fail(fenced("operation", "Runner returned a receipt for a different operation"))
            if (!sameEvidence(binding, response.evidence.binding))
              return Effect.fail(fenced("generation", "Runner returned a receipt from a stale binding"))
            return Effect.succeed(response.evidence)
          }),
        ),
      cancel: (operationId) =>
        rpc({ _tag: "Cancel", operationId }).pipe(
          Effect.flatMap((response) => {
            if (response._tag !== "CancelResult")
              return Effect.fail(fenced("protocol", "Runner returned the wrong cancellation response"))
            if (
              response.cancellation._tag === "AlreadyTerminal" &&
              (response.cancellation.result.operationId !== operationId ||
                !sameBinding(binding, response.cancellation.result.binding))
            )
              return Effect.fail(fenced("operation", "Runner cancellation returned a different operation"))
            return Effect.succeed(response.cancellation)
          }),
        ),
    }

    const receive = Effect.fn("RikaExecutionV2.WorkspaceExecutorTransport.receive")(function* (
      value: WorkspaceExecutorWebSocketData,
    ) {
      const text = yield* frameText(value, limits.maxFrameBytes).pipe(
        Effect.catch((error) => rejectConnection(error)),
      )
      const frame = yield* decodeRunnerFrame(text).pipe(
        Effect.mapError(() => fenced("protocol", "Runner WebSocket frame does not match the protocol")),
        Effect.catch((error) => rejectConnection(error)),
      )
      if (frame._tag === "Enroll") {
        const current = yield* Ref.get(state)
        if (current !== "awaiting-enrollment")
          return yield* rejectConnection(fenced("protocol", "Runner sent a duplicate enrollment frame"))
        if (!sameBinding(binding, frame.binding))
          return yield* rejectConnection(
            fenced(
              bindingMismatchReason(binding, frame.binding) ?? "generation",
              "Runner enrollment does not match the authorized assignment",
            ),
          )
        yield* Ref.set(state, "ready")
        yield* send({ _tag: "Enrolled", binding: toEvidence(binding) }).pipe(
          Effect.catch((error) => rejectConnection(error)),
        )
        yield* Deferred.succeed(ready, toEvidence(binding))
        return
      }
      if ((yield* Ref.get(state)) !== "ready")
        return yield* rejectConnection(fenced("protocol", "Runner responded before enrollment"))
      const entry = (yield* Ref.get(pending)).get(frame.id)
      if (entry === undefined) {
        const ignored = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const known = yield* Ref.get(retired)
            if (!known.has(frame.id)) return false
            const next = new Set(known)
            next.delete(frame.id)
            yield* Ref.set(retired, next)
            return true
          }),
        )
        if (ignored) return
        return yield* rejectConnection(fenced("protocol", "Runner response has no matching RPC"))
      }
      yield* retire(frame.id, entry)
      if (frame._tag === "Failure") {
        yield* Deferred.fail(entry.result, frame.error)
        return
      }
      if (frame.response._tag !== entry.expected) {
        const error = fenced("protocol", "Runner response kind does not match the requested RPC")
        yield* Deferred.fail(entry.result, error)
        return yield* rejectConnection(error)
      }
      yield* Deferred.succeed(entry.result, frame.response)
    })

    const disconnected = () =>
      shutdown(transport("connection", "Runner WebSocket disconnected")).pipe(Effect.asVoid)

    return yield* Effect.acquireRelease(
      Effect.succeed({ executor, ready: Deferred.await(ready), receive, disconnected }),
      (server) => server.disconnected(),
    )
  })

export const makeWorkspaceExecutorWebSocketServer = makeServer

export const WorkspaceExecutorTransport = {
  WorkspaceExecutorRpcFailure,
  WorkspaceExecutorRpcRequest,
  WorkspaceExecutorRpcResponse,
  WorkspaceExecutorRunnerFrame,
  WorkspaceExecutorServerFrame,
  defaultLimits: defaultWorkspaceExecutorTransportLimits,
  makeServer: makeWorkspaceExecutorWebSocketServer,
  protocol: workspaceExecutorWebSocketProtocol,
}
