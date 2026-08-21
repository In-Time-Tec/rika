import { HostBindingRegistry } from "tenetkit/repl"
import { Crypto, Deferred, Effect, Encoding, Layer, Ref, Schema } from "effect"
import type { AccessWire, BindingManifest, BindingOutcome, BindingRequest, CellRequest } from "./protocol"
import { bindingManifest, BindingRequest as BindingRequestSchema } from "./protocol"

export class BindingProxyError extends Schema.TaggedError<BindingProxyError>()("BindingProxyError", {
  message: Schema.String,
}) {}

interface ActiveCell {
  readonly access: AccessWire
  readonly operationKey: string
  readonly attempt: number
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
    HostBindingRegistry.HostBindingNotFound.make({
      module: request.module,
      ...(known.has(request.module) ? { operation: request.operation } : {}),
    })
  const resolve: HostBindingRegistry.Interface["resolve"] = (request) => {
    if (known.get(request.module)?.has(request.operation) !== true) return notFound(request)
    return Effect.succeed({
      name: request.operation,
      input: Schema.Unknown,
      output: Schema.Unknown,
      failure: Schema.Unknown,
      handle: () => Effect.die("proxy operations are invoked through the remote registry"),
    } as HostBindingRegistry.AnyOperation)
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
        const wireRequest: BindingRequest = {
          module: request.module,
          operation: request.operation,
          ...(request.input === undefined ? {} : { input: request.input as NonNullable<BindingRequest["input"]> }),
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          ...(request.cellId === undefined ? {} : { cellId: request.cellId }),
        }
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
            result,
          }),
        )
        yield* transport
          .send({
            access: cell.access,
            operationKey: cell.operationKey,
            attempt: cell.attempt,
            callId,
            requestDigest,
            request: wireRequest,
          })
          .pipe(
            Effect.mapError(() =>
              HostBindingRegistry.HostBindingSchemaFailure.make({
                module: request.module,
                operation: request.operation,
                stage: "decode-input",
                message: "binding request transport is unavailable",
              }),
            ),
          )
        const outcome = yield* Deferred.await(result).pipe(
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
        if (outcome._tag === "Returned") return outcome.response as HostBindingRegistry.Response
        if (outcome._tag === "Rejected") {
          if (outcome.failure._tag === "tenetkit/repl/HostBindingNotFound")
            return yield* HostBindingRegistry.HostBindingNotFound.make({
              module: outcome.failure.module,
              ...(outcome.failure.operation === undefined ? {} : { operation: outcome.failure.operation }),
            })
          return yield* HostBindingRegistry.HostBindingSchemaFailure.make({
            module: outcome.failure.module,
            operation: outcome.failure.operation,
            stage: outcome.failure.stage,
            message: outcome.failure.message,
          })
        }
        return yield* Effect.never
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
  const replay = (access: AccessWire) =>
    Ref.get(pending).pipe(
      Effect.flatMap((calls) =>
        Effect.forEach(
          calls.values(),
          (call) =>
            transport.send({
              access,
              operationKey: call.operationKey,
              attempt: call.attempt,
              callId: call.callId,
              requestDigest: call.requestDigest,
              request: call.request,
            }),
          { discard: true },
        ),
      ),
    )
  const complete: Interface["complete"] = (input) =>
    Effect.gen(function* () {
      const call = (yield* Ref.get(pending)).get(input.callId)
      if (
        call === undefined ||
        call.operationKey !== input.operationKey ||
        call.attempt !== input.attempt ||
        call.requestDigest !== input.requestDigest
      )
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
