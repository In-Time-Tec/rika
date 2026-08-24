import { HostBindingRegistry } from "tenetkit/repl"
import { Clock, Crypto, DateTime, Deferred, Effect, Encoding, Layer, Ref, Schema } from "effect"
import type { AccessWire, BindingManifest, BindingOutcome, BindingRequest, CellRequest } from "./messages"
import { bindingManifest, BindingRequest as BindingRequestSchema } from "./messages"

export class BindingProxyError extends Schema.TaggedError<BindingProxyError>()("BindingProxyError", {
  message: Schema.String,
}) {}

interface ActiveCell {
  readonly access: AccessWire
  readonly operationKey: string
  readonly attempt: number
  readonly deadlineAtMillis: number
  readonly nextOrdinal: Ref.Ref<number>
  readonly suspension: Deferred.Deferred<string>
  readonly unknown: Deferred.Deferred<string>
}

interface PendingCall {
  readonly callId: string
  readonly operationKey: string
  readonly attempt: number
  readonly requestDigest: string
  readonly request: BindingRequest
  readonly deadlineAtMillis: number
  readonly result: Deferred.Deferred<BindingOutcome, BindingProxyError>
}

export interface Transport {
  readonly send: (message: {
    readonly access: AccessWire
    readonly operationKey: string
    readonly attempt: number
    readonly callId: string
    readonly requestDigest: string
    readonly request: BindingRequest
  }) => Effect.Effect<void, BindingProxyError>
}

export interface Interface {
  readonly registry: HostBindingRegistry.Interface
  readonly enter: (request: CellRequest) => Effect.Effect<void, BindingProxyError>
  readonly leave: (request: CellRequest) => Effect.Effect<void>
  readonly suspended: (request: CellRequest) => Effect.Effect<string, BindingProxyError>
  readonly unknown: (request: CellRequest) => Effect.Effect<string, BindingProxyError>
  readonly replay: (access: AccessWire) => Effect.Effect<void, BindingProxyError>
  readonly complete: (input: {
    readonly operationKey: string
    readonly attempt: number
    readonly callId: string
    readonly requestDigest: string
    readonly outcome: BindingOutcome
  }) => Effect.Effect<BindingOutcome, BindingProxyError>
}

const requestKey = (sessionId: string | undefined, cellId: string | undefined) =>
  `${sessionId ?? ""}\u0000${cellId ?? ""}`
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequestSchema))

export const make: (options: {
  readonly manifest: BindingManifest
  readonly transport: Transport
}) => Effect.Effect<Interface, BindingProxyError, Crypto.Crypto> = Effect.fn("BindingProxy.make")(function* (options) {
  const { manifest, transport } = options
  const crypto = yield* Crypto.Crypto
  const verified = yield* bindingManifest(manifest.descriptors)
  if (verified.digest !== manifest.digest)
    return yield* BindingProxyError.make({ message: "binding manifest digest is invalid" })
  const active = yield* Ref.make(new Map<string, ActiveCell>())
  const pending = yield* Ref.make(new Map<string, PendingCall>())
  const known = new Map(
    manifest.descriptors.map((descriptor) => [descriptor.module, new Set(descriptor.operations)] as const),
  )
  const notFound = (request: HostBindingRegistry.Request) =>
    known.has(request.module)
      ? HostBindingRegistry.HostBindingNotFound.make({ module: request.module, operation: request.operation })
      : HostBindingRegistry.HostBindingNotFound.make({ module: request.module })
  const resolve: HostBindingRegistry.Interface["resolve"] = (request) => {
    if (known.get(request.module)?.has(request.operation) !== true) return notFound(request)
    const operation: HostBindingRegistry.AnyOperation = {
      name: request.operation,
      input: Schema.Unknown,
      output: Schema.Unknown,
      failure: Schema.Unknown,
      handle: () => Effect.die("proxy operations are invoked through the remote registry"),
    }
    return Effect.succeed(operation)
  }
  const registry: HostBindingRegistry.Interface = {
    descriptors: manifest.descriptors,
    resolve,
    invoke: (request) =>
      Effect.gen(function* () {
        if (known.get(request.module)?.has(request.operation) !== true) return yield* notFound(request)
        const cell = (yield* Ref.get(active)).get(requestKey(request.sessionId, request.cellId))
        if (cell === undefined)
          return yield* HostBindingRegistry.HostBindingSchemaFailure.make({
            module: request.module,
            operation: request.operation,
            stage: "decode-input",
            message: "binding call does not belong to an active remote cell",
          })
        const ordinal = yield* Ref.getAndUpdate(cell.nextOrdinal, (value) => value + 1)
        const callId = `${cell.operationKey}:binding:${ordinal}`
        const wireRequest = yield* Schema.decodeUnknownEffect(BindingRequestSchema)(request).pipe(
          Effect.mapError(() =>
            HostBindingRegistry.HostBindingSchemaFailure.make({
              module: request.module,
              operation: request.operation,
              stage: "decode-input",
              message: "binding input is not JSON",
            }),
          ),
        )
        const requestDigest = Encoding.encodeHex(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(encodeRequest(wireRequest))).pipe(
            Effect.mapError(() =>
              HostBindingRegistry.HostBindingSchemaFailure.make({
                module: request.module,
                operation: request.operation,
                stage: "decode-input",
                message: "could not identify binding request",
              }),
            ),
          ),
        )
        const result = yield* Deferred.make<BindingOutcome, BindingProxyError>()
        yield* Ref.update(pending, (current) =>
          new Map(current).set(callId, {
            callId,
            operationKey: cell.operationKey,
            attempt: cell.attempt,
            requestDigest,
            request: wireRequest,
            deadlineAtMillis: cell.deadlineAtMillis,
            result,
          }),
        )
        const remaining = Math.max(0, cell.deadlineAtMillis - (yield* Clock.currentTimeMillis))
        const outcome = yield* transport
          .send({
            access: cell.access,
            operationKey: cell.operationKey,
            attempt: cell.attempt,
            callId,
            requestDigest,
            request: wireRequest,
          })
          .pipe(
            Effect.andThen(
              Deferred.await(result).pipe(
                Effect.timeoutOrElse({
                  duration: remaining,
                  orElse: () => BindingProxyError.make({ message: "cell binding deadline exceeded" }),
                }),
              ),
            ),
            Effect.mapError((error) =>
              HostBindingRegistry.HostBindingSchemaFailure.make({
                module: request.module,
                operation: request.operation,
                stage: "decode-input",
                message: error.message,
              }),
            ),
            Effect.ensuring(
              Ref.update(pending, (current) => {
                const next = new Map(current)
                next.delete(callId)
                return next
              }),
            ),
          )
        if (outcome._tag === "Returned")
          return outcome.response._tag === "Success"
            ? { _tag: "Success", output: outcome.response.output }
            : { _tag: "Failure", failure: outcome.response.failure }
        if (outcome._tag === "Rejected") {
          if (outcome.failure._tag === "tenetkit/repl/HostBindingNotFound")
            return yield* outcome.failure.operation === undefined
              ? HostBindingRegistry.HostBindingNotFound.make({ module: outcome.failure.module })
              : HostBindingRegistry.HostBindingNotFound.make({
                  module: outcome.failure.module,
                  operation: outcome.failure.operation,
                })
          return yield* HostBindingRegistry.HostBindingSchemaFailure.make({
            module: outcome.failure.module,
            operation: outcome.failure.operation,
            stage: outcome.failure.stage,
            message: outcome.failure.message,
          })
        }
        return yield* HostBindingRegistry.HostBindingSchemaFailure.make({
          module: request.module,
          operation: request.operation,
          stage: "decode-input",
          message: outcome._tag === "Unknown" ? outcome.message : "cell binding suspended",
        })
      }),
  }
  const enter = (request: CellRequest) =>
    manifest.digest !== request.bindings.digest ||
    !Schema.toEquivalence(
      Schema.Array(Schema.Struct({ module: Schema.String, operations: Schema.Array(Schema.String) })),
    )(manifest.descriptors, request.bindings.descriptors)
      ? Effect.fail(BindingProxyError.make({ message: "cell binding manifest does not match the mounted kernel" }))
      : Effect.gen(function* () {
          const nextOrdinal = yield* Ref.make(0)
          const suspension = yield* Deferred.make<string>()
          const unknown = yield* Deferred.make<string>()
          yield* Ref.update(active, (current) =>
            new Map(current).set(requestKey(request.sessionId, request.toolCallId), {
              access: request.access,
              operationKey: request.operationKey,
              attempt: request.attempt,
              deadlineAtMillis: DateTime.toEpochMillis(DateTime.makeUnsafe(request.deadlineAt)),
              nextOrdinal,
              suspension,
              unknown,
            }),
          )
        })
  const leave = (request: CellRequest) =>
    Ref.update(active, (current) => {
      const next = new Map(current)
      next.delete(requestKey(request.sessionId, request.toolCallId))
      return next
    })
  const suspended = (request: CellRequest) =>
    Ref.get(active).pipe(
      Effect.flatMap((current) => {
        const cell = current.get(requestKey(request.sessionId, request.toolCallId))
        return cell === undefined
          ? Effect.fail(BindingProxyError.make({ message: "cell binding authority is no longer active" }))
          : Deferred.await(cell.suspension)
      }),
    )
  const unknown = (request: CellRequest) =>
    Ref.get(active).pipe(
      Effect.flatMap((current) => {
        const cell = current.get(requestKey(request.sessionId, request.toolCallId))
        return cell === undefined
          ? Effect.fail(BindingProxyError.make({ message: "cell binding authority is no longer active" }))
          : Deferred.await(cell.unknown)
      }),
    )
  const removePending = (expected: PendingCall) =>
    Ref.modify(pending, (current) => {
      if (current.get(expected.callId) !== expected) return [false, current] as const
      const next = new Map(current)
      next.delete(expected.callId)
      return [true, next] as const
    })
  const replay = (access: AccessWire) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const calls = yield* Ref.get(pending)
      yield* Effect.forEach(
        calls.values(),
        (call) =>
          call.deadlineAtMillis <= now
            ? removePending(call).pipe(
                Effect.flatMap((removed) =>
                  removed
                    ? Deferred.fail(call.result, BindingProxyError.make({ message: "cell binding deadline exceeded" }))
                    : Effect.void,
                ),
              )
            : transport.send({
                access,
                operationKey: call.operationKey,
                attempt: call.attempt,
                callId: call.callId,
                requestDigest: call.requestDigest,
                request: call.request,
              }),
        { discard: true },
      )
    })
  const complete: Interface["complete"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const call = yield* Ref.modify(pending, (current) => {
        const pendingCall = current.get(input.callId)
        if (
          pendingCall === undefined ||
          pendingCall.operationKey !== input.operationKey ||
          pendingCall.attempt !== input.attempt ||
          pendingCall.requestDigest !== input.requestDigest ||
          pendingCall.deadlineAtMillis <= now
        )
          return [undefined, current] as const
        const next = new Map(current)
        next.delete(input.callId)
        return [pendingCall, next] as const
      })
      if (call === undefined)
        return yield* BindingProxyError.make({ message: "binding result conflicts with its request identity" })
      yield* Deferred.succeed(call.result, input.outcome)
      if (input.outcome._tag === "Suspend") {
        const cell = Array.from((yield* Ref.get(active)).values()).find(
          (candidate) => candidate.operationKey === input.operationKey && candidate.attempt === input.attempt,
        )
        if (cell !== undefined) yield* Deferred.succeed(cell.suspension, input.outcome.token)
      }
      if (input.outcome._tag === "Unknown") {
        const cell = Array.from((yield* Ref.get(active)).values()).find(
          (candidate) => candidate.operationKey === input.operationKey && candidate.attempt === input.attempt,
        )
        if (cell !== undefined) yield* Deferred.succeed(cell.unknown, input.outcome.message)
      }
      return input.outcome
    })
  return { registry, enter, leave, suspended, unknown, replay, complete } satisfies Interface
})

export const layer = (registry: HostBindingRegistry.Interface): Layer.Layer<HostBindingRegistry.HostBindingRegistry> =>
  HostBindingRegistry.layerTest(registry)
