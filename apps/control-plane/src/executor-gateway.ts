import type { ControllerError, Interface as Controller } from "@rika/e2b-executor/controller"
import {
  ControllerMessage,
  HostMessage,
  redactAccess,
  redactHeartbeat,
  redactHello,
  type AccessWire,
  type CellResponse,
  type Fence,
  type HostMessage as HostMessageValue,
} from "@rika/remote-execution/protocol"
import { Clock, Deferred, Effect, Option, Redacted, Ref, Schema, Semaphore } from "effect"

export interface Socket {
  readonly send: (message: string) => unknown
  readonly close: (code?: number, reason?: string) => unknown
}

interface Session {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
}

export interface ExecutionResult {
  readonly access: AccessWire
  readonly response: CellResponse
}

interface Pending {
  readonly assignmentId: string
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<ExecutionResult, GatewayError>
  readonly waiters: number
}

export class GatewayError extends Schema.TaggedError<GatewayError>()("ExecutorGatewayError", {
  kind: Schema.Literals(["disconnected", "fenced", "timeout", "transport"]),
  message: Schema.String,
}) {}

export interface ExecuteInput {
  readonly assignmentId: string
  readonly operationKey: string
  readonly workspace: string
  readonly sessionId: string
  readonly code: string
  readonly attempt?: number
}

export interface Gateway {
  readonly receive: (socket: Socket, frame: unknown) => Effect.Effect<void>
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly execute: (input: ExecuteInput) => Effect.Effect<ExecutionResult, GatewayError>
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(HostMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ControllerMessage))
const key = (assignmentId: string, operationKey: string) => `${assignmentId}\u0000${operationKey}`

const sameAccess = (left: AccessWire, right: AccessWire) =>
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.target === right.fence.target &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const accessFailure = (error: ControllerError) =>
  GatewayError.make({
    kind: error.kind === "fenced" || error.kind === "lease-expired" ? "fenced" : "transport",
    message: error.message,
  })

const expired = () => GatewayError.make({ kind: "fenced", message: "Executor lease expired before work could be sent" })

const disconnectedFailure = () =>
  GatewayError.make({ kind: "disconnected", message: "Executor disconnected before returning a result" })

const fenceOf = (message: HostMessageValue): Fence | undefined => {
  switch (message._tag) {
    case "ExecutorHello":
      return message.hello.fence
    case "ExecutorReconnect":
      return message.access.fence
    case "ExecutorHeartbeat":
      return message.heartbeat.access.fence
    case "CheckpointStaged":
    case "CheckoutRequested":
    case "PtyOpened":
    case "PtyOutput":
    case "PtyDisconnected":
      return message.access.fence
    case "CellResult":
      return undefined
  }
}

const close = (socket: Socket, code: number, reason: string) => {
  socket.close(code, reason)
}

const failure = (socket: Socket, message: HostMessageValue, error: ControllerError) => {
  const fence = fenceOf(message)
  if (fence !== undefined) socket.send(encode({ _tag: "Fenced", fence, message: error.message }))
  close(socket, 1008, error.kind)
}

export const makeGateway = Effect.fn("ExecutorGateway.make")(function* (controller: Controller) {
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const pending = yield* Ref.make(new Map<string, Pending>())
  const admission = yield* Semaphore.make(1)

  const register = Effect.fn("ExecutorGateway.register")(function* (session: Session) {
    return yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = session.access.fence.assignmentId
        const currentSession = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId)))
        if (
          currentSession !== undefined &&
          currentSession.socket !== session.socket &&
          sameAccess(currentSession.access, session.access)
        ) {
          close(session.socket, 1008, "duplicate")
          return false
        }
        const previousAssignment = yield* Ref.get(assignments).pipe(
          Effect.map((current) => current.get(session.socket)),
        )
        const displaced = yield* Ref.modify(sessions, (current) => {
          const previous = current.get(assignmentId)
          const priorSession = previousAssignment === undefined ? undefined : current.get(previousAssignment)
          const next = new Map(current)
          if (
            previousAssignment !== undefined &&
            previousAssignment !== assignmentId &&
            priorSession?.socket === session.socket
          )
            next.delete(previousAssignment)
          next.set(assignmentId, session)
          return [{ previous, previousAssignment }, next] as const
        })
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          if (displaced.previous !== undefined && displaced.previous.socket !== session.socket)
            next.delete(displaced.previous.socket)
          next.set(session.socket, assignmentId)
          return next
        })
        const failed = yield* Ref.modify(
          pending,
          (
            current,
          ): readonly [ReadonlyArray<Deferred.Deferred<ExecutionResult, GatewayError>>, Map<string, Pending>] => {
            const displacedPending = [...current.entries()].filter(([, operation]) => {
              if (operation.assignmentId === assignmentId)
                return operation.socket !== session.socket || !sameAccess(operation.access, session.access)
              return (
                displaced.previousAssignment !== undefined &&
                displaced.previousAssignment !== assignmentId &&
                operation.assignmentId === displaced.previousAssignment &&
                operation.socket === session.socket
              )
            })
            if (displacedPending.length === 0) return [[], current] as const
            const next = new Map(current)
            for (const [pendingKey] of displacedPending) next.delete(pendingKey)
            return [displacedPending.map(([, operation]) => operation.result), next] as const
          },
        )
        if (displaced.previous !== undefined && displaced.previous.socket !== session.socket)
          close(displaced.previous.socket, 1008, "fenced")
        yield* Effect.forEach(
          failed,
          (result) =>
            Deferred.fail(
              result,
              GatewayError.make({
                kind: "disconnected",
                message: "Executor connection was replaced before returning a result",
              }),
            ),
          { discard: true },
        )
        return true
      }),
    )
  })

  const disconnected = Effect.fn("ExecutorGateway.disconnected")(function* (socket: Socket) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.modify(assignments, (current) => {
          const known = current.get(socket)
          if (known === undefined) return [undefined, current] as const
          const next = new Map(current)
          next.delete(socket)
          return [known, next] as const
        })
        if (assignmentId !== undefined)
          yield* Ref.update(sessions, (current) => {
            if (current.get(assignmentId)?.socket !== socket) return current
            const next = new Map(current)
            next.delete(assignmentId)
            return next
          })
        const waiting = yield* Ref.modify(
          pending,
          (
            current,
          ): readonly [ReadonlyArray<Deferred.Deferred<ExecutionResult, GatewayError>>, Map<string, Pending>] => {
            const failed = [...current.entries()].filter(([, value]) => value.socket === socket)
            if (failed.length === 0) return [[], current] as const
            const next = new Map(current)
            for (const [pendingKey] of failed) next.delete(pendingKey)
            return [failed.map(([, value]) => value.result), next] as const
          },
        )
        yield* Effect.forEach(waiting, (result) => Deferred.fail(result, disconnectedFailure()), { discard: true })
      }),
    )
  })

  const complete = Effect.fn("ExecutorGateway.complete")(function* (
    socket: Socket,
    operationKey: string,
    response: CellResponse,
  ) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
        if (assignmentId === undefined) return
        const operation = yield* Ref.get(pending).pipe(
          Effect.map((current) => current.get(key(assignmentId, operationKey))),
        )
        if (operation === undefined || operation.socket !== socket) return
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId)))
        if (session === undefined || session.socket !== socket || !sameAccess(session.access, operation.access)) return
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) {
          yield* Deferred.fail(operation.result, expired())
          return
        }
        yield* controller.validateAccess(redactAccess(operation.access)).pipe(
          Effect.matchEffect({
            onFailure: (error) => Deferred.fail(operation.result, accessFailure(error)),
            onSuccess: () => Deferred.succeed(operation.result, { access: operation.access, response }),
          }),
        )
      }),
    )
  })

  const recover = Effect.fn("ExecutorGateway.recover")(function* (
    message: HostMessageValue,
    error: ControllerError,
  ) {
    if (message._tag !== "ExecutorReconnect" || error.kind !== "fenced") return
    const current = yield* Ref.get(sessions).pipe(
      Effect.map((active) => active.get(message.access.fence.assignmentId)),
    )
    if (current !== undefined) return
    const successor = {
      ...message.access,
      leaseEpoch: message.access.leaseEpoch + 1,
    }
    const acknowledged = yield* Effect.result(controller.validateAccess(redactAccess(successor)))
    if (acknowledged._tag === "Failure") return
    yield* controller
      .replace({
        assignmentId: message.access.fence.assignmentId,
        generation: message.access.fence.assignmentGeneration,
      })
      .pipe(Effect.catchCause(() => Effect.void))
  })

  const handle = Effect.fn("ExecutorGateway.handle")(function* (socket: Socket, message: HostMessageValue) {
    switch (message._tag) {
      case "ExecutorHello": {
        const welcome = yield* controller.hello(redactHello(message.hello))
        const sessionToken = Redacted.value(welcome.sessionToken)
        const registered = yield* register({
          socket,
          access: { version: 1, fence: welcome.fence, leaseEpoch: welcome.leaseEpoch, sessionToken },
          leaseExpiresAt: welcome.leaseExpiresAt,
        })
        if (registered) socket.send(encode({ _tag: "ExecutorWelcome", welcome: { ...welcome, sessionToken } }))
        return
      }
      case "ExecutorReconnect": {
        const welcome = yield* controller.reconnect(redactAccess(message.access))
        const registered = yield* register({
          socket,
          access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
          leaseExpiresAt: welcome.leaseExpiresAt,
        })
        if (registered) socket.send(encode({ _tag: "ExecutorReconnected", welcome }))
        return
      }
      case "ExecutorHeartbeat": {
        const receipt = yield* controller.heartbeat(redactHeartbeat(message.heartbeat))
        const registered = yield* register({
          socket,
          access: { ...message.heartbeat.access, leaseEpoch: receipt.leaseEpoch },
          leaseExpiresAt: receipt.leaseExpiresAt,
        })
        if (registered) socket.send(encode({ _tag: "LeaseReceipt", receipt }))
        return
      }
      case "CheckpointStaged": {
        const checkpoint = yield* controller.checkpoint(redactAccess(message.access), message.checkpoint)
        socket.send(
          encode({
            _tag: "CheckpointAccepted",
            checkpointId: checkpoint.checkpoint.checkpointId,
            contentDigest: checkpoint.checkpoint.contentDigest,
          }),
        )
        return
      }
      case "CheckoutRequested": {
        const credential = yield* controller.checkout(redactAccess(message.access))
        socket.send(
          encode({
            _tag: "CheckoutCredential",
            credential: { ...credential, requestId: message.requestId, token: Redacted.value(credential.token) },
          }),
        )
        return
      }
      case "CellResult":
        return yield* complete(socket, message.operationKey, message.response)
      case "PtyOpened":
      case "PtyOutput":
      case "PtyDisconnected":
        close(socket, 1003, "unsupported")
        return
    }
  })

  const receive = (socket: Socket, frame: unknown) =>
    decode(frame).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sync(() => close(socket, 1007, "malformed")),
        onSuccess: (message) =>
          handle(socket, message).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                recover(message, error).pipe(
                  Effect.andThen(Effect.sync(() => failure(socket, message, error))),
                ),
              onSuccess: () => Effect.void,
            }),
          ),
      }),
      Effect.asVoid,
    )

  const awaitSession = (assignmentId: string): Effect.Effect<Session> =>
    Effect.suspend(() =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(assignmentId)
          return session === undefined
            ? Effect.sleep("100 millis").pipe(Effect.andThen(awaitSession(assignmentId)))
            : Effect.succeed(session)
        }),
      ),
    )

  const execute = Effect.fn("ExecutorGateway.execute")(function* (input: ExecuteInput) {
    const connected = yield* awaitSession(input.assignmentId).pipe(Effect.timeoutOption("30 seconds"))
    if (Option.isNone(connected))
      return yield* GatewayError.make({ kind: "timeout", message: "Executor did not connect in time" })
    const pendingKey = key(input.assignmentId, input.operationKey)
    const operation = yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
        if (session === undefined)
          return yield* GatewayError.make({
            kind: "disconnected",
            message: "Executor disconnected before work could be sent",
          })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
        yield* controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
        const result = yield* Deferred.make<ExecutionResult, GatewayError>()
        const known = yield* Ref.get(pending).pipe(Effect.map((current) => current.get(pendingKey)))
        if (known !== undefined && known.socket === session.socket && sameAccess(known.access, session.access)) {
          yield* Ref.update(pending, (current) => {
            const currentOperation = current.get(pendingKey)
            if (currentOperation?.result !== known.result) return current
            const next = new Map(current)
            next.set(pendingKey, { ...currentOperation, waiters: currentOperation.waiters + 1 })
            return next
          })
          return known
        }
        if (known !== undefined) {
          yield* Ref.update(pending, (current) => {
            if (current.get(pendingKey)?.result !== known.result) return current
            const next = new Map(current)
            next.delete(pendingKey)
            return next
          })
          yield* Deferred.fail(
            known.result,
            GatewayError.make({
              kind: "disconnected",
              message: "Executor connection was replaced before returning a result",
            }),
          )
        }
        const created: Pending = {
          assignmentId: input.assignmentId,
          socket: session.socket,
          access: session.access,
          result,
          waiters: 1,
        }
        yield* Ref.update(pending, (current) => new Map(current).set(pendingKey, created))
        yield* Effect.try({
          try: () =>
            session.socket.send(
              encode({
                _tag: "CellExecute",
                request: {
                  access: session.access,
                  operationKey: input.operationKey,
                  workspace: input.workspace,
                  sessionId: input.sessionId,
                  toolCallId: input.operationKey,
                  code: input.code,
                  ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
                },
              }),
            ),
          catch: () => GatewayError.make({ kind: "transport", message: "Could not send work to the executor" }),
        }).pipe(
          Effect.tapError((error) => Deferred.fail(created.result, error)),
          Effect.tapError(() =>
            Ref.update(pending, (current) => {
              if (current.get(pendingKey)?.result !== created.result) return current
              const next = new Map(current)
              next.delete(pendingKey)
              return next
            }),
          ),
        )
        return created
      }),
    )
    const removePending = admission.withPermits(1)(
      Ref.update(pending, (current) => {
        const known = current.get(pendingKey)
        if (known === undefined || known.result !== operation.result) return current
        const next = new Map(current)
        if (known.waiters === 1) next.delete(pendingKey)
        else next.set(pendingKey, { ...known, waiters: known.waiters - 1 })
        return next
      }),
    )
    return yield* Deferred.await(operation.result).pipe(
      Effect.timeoutOption("60 seconds"),
      Effect.flatMap((completed) =>
        Option.isNone(completed)
          ? GatewayError.make({ kind: "timeout", message: "Executor operation did not finish in time" })
          : Effect.succeed(completed.value),
      ),
      Effect.ensuring(removePending),
    )
  })

  return { receive, disconnected, execute } satisfies Gateway
})
