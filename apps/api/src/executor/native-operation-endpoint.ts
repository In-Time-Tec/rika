import type { AccessWire, ApiMessage, MachineOutcome, MachineRequest } from "@rika/remote-execution/protocol"
import { Clock, Deferred, Effect, Ref, Semaphore } from "effect"
import { GatewayError, type Socket } from "./gateway/contract"

export interface NativeOperationSession {
  readonly socket: Socket
  readonly access: AccessWire
}

export interface NativeOperationIdentity {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly machineId: string
}

export interface NativeOperationRequest extends NativeOperationIdentity {
  readonly request: MachineRequest
  readonly deadlineAtMillis: number
}

interface PendingNativeOperation extends NativeOperationRequest {
  readonly requestDigest: string
  readonly session: NativeOperationSession | undefined
  readonly cancelling: boolean
  readonly result: Deferred.Deferred<MachineOutcome, GatewayError>
}

interface NativeOperationEndpointOptions {
  readonly digest: (value: string) => Effect.Effect<string, GatewayError>
  readonly encodeRequest: (request: MachineRequest) => string
  readonly session: (assignmentId: string) => Effect.Effect<NativeOperationSession | undefined>
  readonly authorize: (
    input: NativeOperationIdentity,
    session: NativeOperationSession,
  ) => Effect.Effect<boolean, GatewayError>
  readonly sameAccess: (left: AccessWire, right: AccessWire) => boolean
  readonly send: (session: NativeOperationSession, message: ApiMessage) => Effect.Effect<void, GatewayError>
}

const callKey = (input: NativeOperationIdentity) =>
  `${input.assignmentId}\u0000${input.operationKey}\u0000${input.attempt}\u0000${input.machineId}`

const conflict = () =>
  GatewayError.make({ kind: "fenced", message: "Native operation key conflicts with a different request" })
const deadline = () =>
  GatewayError.make({ kind: "timeout", message: "Native operation did not settle before its deadline" })
const unavailable = () =>
  GatewayError.make({ kind: "disconnected", message: "Native operation executor is no longer available" })

export const nativeOperationEndpoint = Effect.fn("NativeOperationEndpoint.make")(function* (
  options: NativeOperationEndpointOptions,
) {
  const pending = yield* Ref.make(new Map<string, PendingNativeOperation>())
  const lock = yield* Semaphore.make(1)

  const settle = Effect.fn("NativeOperationEndpoint.settle")(function* (
    key: string,
    operation: PendingNativeOperation,
    outcome: MachineOutcome,
  ) {
    yield* lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(operation.result, outcome)
          yield* Ref.update(pending, (current) => {
            if (current.get(key)?.result !== operation.result) return current
            const next = new Map(current)
            next.delete(key)
            return next
          })
        }),
      ),
    )
    return yield* Deferred.await(operation.result)
  })

  const fail = Effect.fn("NativeOperationEndpoint.fail")(function* (
    key: string,
    operation: PendingNativeOperation,
    error: GatewayError,
  ) {
    yield* lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.fail(operation.result, error)
          yield* Ref.update(pending, (current) => {
            if (current.get(key)?.result !== operation.result) return current
            const next = new Map(current)
            next.delete(key)
            return next
          })
        }),
      ),
    )
    return yield* Deferred.await(operation.result)
  })

  const deliver = (key: string, operation: PendingNativeOperation, session: NativeOperationSession) => {
    const correlation = {
      access: session.access,
      operationKey: operation.operationKey,
      attempt: operation.attempt,
      machineId: operation.machineId,
      requestDigest: operation.requestDigest,
    }
    return options
      .send(
        session,
        operation.cancelling
          ? { _tag: "MachineCancel", ...correlation }
          : { _tag: "MachineExecute", ...correlation, request: operation.request },
      )
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("native-operation.delivery-failed").pipe(
            Effect.annotateLogs({
              "rika.assignment.id": operation.assignmentId,
              "rika.operation.key": operation.operationKey,
              "rika.error.kind": error.kind,
              "rika.error.message": error.message,
            }),
            Effect.andThen(
              Ref.update(pending, (current) => {
                const known = current.get(key)
                if (known?.result !== operation.result || known.session?.socket !== session.socket) return current
                const next = new Map(current)
                next.delete(key)
                return next
              }),
            ),
          ),
        ),
      )
  }

  const awaitOutcome = (key: string, operation: PendingNativeOperation) =>
    Effect.gen(function* () {
      const remaining = Math.max(0, operation.deadlineAtMillis - (yield* Clock.currentTimeMillis))
      return yield* Deferred.await(operation.result).pipe(
        Effect.timeoutOrElse({ duration: remaining, orElse: () => fail(key, operation, deadline()) }),
      )
    })

  const invoke = Effect.fn("NativeOperationEndpoint.invoke")(function* (input: NativeOperationRequest) {
    const requestDigest = yield* options.digest(options.encodeRequest(input.request))
    const session = yield* options.session(input.assignmentId)
    if (session === undefined || !(yield* options.authorize(input, session))) return yield* unavailable()
    const key = callKey(input)
    const candidate: PendingNativeOperation = {
      ...input,
      requestDigest,
      session,
      cancelling: false,
      result: yield* Deferred.make<MachineOutcome, GatewayError>(),
    }
    const admitted = yield* lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(pending)
          const known = current.get(key)
          if (known !== undefined && known.requestDigest !== requestDigest) return yield* conflict()
          if ((yield* Clock.currentTimeMillis) >= input.deadlineAtMillis) return known
          if (known !== undefined) {
            if (
              known.session !== undefined &&
              known.session.socket === session.socket &&
              options.sameAccess(known.session.access, session.access)
            )
              return known
            const connected = { ...known, session }
            yield* Ref.set(pending, new Map(current).set(key, connected))
            yield* deliver(key, connected, session)
            return connected
          }
          yield* Ref.set(pending, new Map(current).set(key, candidate))
          yield* deliver(key, candidate, session)
          return candidate
        }),
      ),
    )
    if (admitted === undefined) return yield* deadline()
    return yield* awaitOutcome(key, admitted)
  })

  const cancel = Effect.fn("NativeOperationEndpoint.cancel")(function* (input: NativeOperationRequest) {
    const requestDigest = yield* options.digest(options.encodeRequest(input.request))
    const session = yield* options.session(input.assignmentId)
    const key = callKey(input)
    const candidate: PendingNativeOperation = {
      ...input,
      requestDigest,
      session,
      cancelling: true,
      result: yield* Deferred.make<MachineOutcome, GatewayError>(),
    }
    const operation = yield* lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(pending)
          const known = current.get(key)
          if (known !== undefined && known.requestDigest !== requestDigest) return yield* conflict()
          if (known === undefined && session === undefined) return undefined
          const cancelling = {
            ...(known ?? candidate),
            session,
            cancelling: true,
          }
          yield* Ref.set(pending, new Map(current).set(key, cancelling))
          if (session !== undefined) yield* deliver(key, cancelling, session)
          return cancelling
        }),
      ),
    )
    if (operation === undefined) return yield* unavailable()
    return yield* awaitOutcome(key, operation)
  })

  const receive = Effect.fn("NativeOperationEndpoint.receive")(function* (
    session: NativeOperationSession,
    input: NativeOperationIdentity & { readonly requestDigest: string; readonly outcome: MachineOutcome },
  ) {
    const key = callKey(input)
    const operation = (yield* Ref.get(pending)).get(key)
    if (operation === undefined) return
    if (
      operation.requestDigest !== input.requestDigest ||
      operation.session?.socket !== session.socket ||
      !options.sameAccess(operation.session.access, session.access)
    )
      return yield* conflict()
    if ((yield* Clock.currentTimeMillis) >= operation.deadlineAtMillis) return yield* fail(key, operation, deadline())
    return yield* settle(key, operation, input.outcome)
  })

  const disconnected = (socket: Socket) =>
    lock.withPermits(1)(
      Ref.update(pending, (current) => {
        const next = new Map(current)
        for (const [key, operation] of next) {
          if (operation.session?.socket !== socket) continue
          next.set(key, { ...operation, session: undefined })
        }
        return next
      }),
    )

  const attach = Effect.fn("NativeOperationEndpoint.attach")(function* (session: NativeOperationSession) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(pending)
        const next = new Map(current)
        const attached: Array<readonly [string, PendingNativeOperation]> = []
        for (const [key, operation] of next) {
          if (
            operation.assignmentId !== session.access.fence.assignmentId ||
            !(yield* options.authorize(operation, session))
          )
            continue
          const connected = { ...operation, session }
          next.set(key, connected)
          attached.push([key, connected])
        }
        yield* Ref.set(pending, next)
        return attached
      }),
    )
  })

  const refreshed = (session: NativeOperationSession) => attach(session).pipe(Effect.asVoid)

  const reconnected = Effect.fn("NativeOperationEndpoint.reconnected")(function* (session: NativeOperationSession) {
    const operations = yield* attach(session)
    const now = yield* Clock.currentTimeMillis
    for (const [key, operation] of operations) {
      if (now >= operation.deadlineAtMillis) yield* fail(key, operation, deadline())
      else yield* deliver(key, operation, session)
    }
  })

  return { cancel, disconnected, invoke, receive, reconnected, refreshed }
})
