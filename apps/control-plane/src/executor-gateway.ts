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
import { Deferred, Effect, Option, Redacted, Ref, Schema } from "effect"

export interface Socket {
  readonly send: (message: string) => unknown
  readonly close: (code?: number, reason?: string) => unknown
}

interface Session {
  readonly socket: Socket
  readonly access: AccessWire
}

export interface ExecutionResult {
  readonly access: AccessWire
  readonly response: CellResponse
}

interface Pending {
  readonly socket: Socket
  readonly result: Deferred.Deferred<ExecutionResult, GatewayError>
  readonly waiters: number
}

export class GatewayError extends Schema.TaggedError<GatewayError>()("ExecutorGatewayError", {
  kind: Schema.Literals(["disconnected", "timeout", "transport"]),
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

  const register = Effect.fn("ExecutorGateway.register")(function* (session: Session) {
    const previous = yield* Ref.modify(sessions, (current) => {
      const known = current.get(session.access.fence.assignmentId)
      const next = new Map(current)
      next.set(session.access.fence.assignmentId, session)
      return [known, next] as const
    })
    yield* Ref.update(assignments, (current) => {
      const next = new Map(current)
      next.set(session.socket, session.access.fence.assignmentId)
      if (previous !== undefined && previous.socket !== session.socket) next.delete(previous.socket)
      return next
    })
    if (previous !== undefined && previous.socket !== session.socket) close(previous.socket, 1008, "fenced")
  })

  const disconnected = Effect.fn("ExecutorGateway.disconnected")(function* (socket: Socket) {
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
      (current): readonly [ReadonlyArray<Deferred.Deferred<ExecutionResult, GatewayError>>, Map<string, Pending>] => {
        const failed = [...current.entries()].filter(([, value]) => value.socket === socket)
        if (failed.length === 0) return [[], current] as const
        const next = new Map(current)
        for (const [pendingKey] of failed) next.delete(pendingKey)
        return [failed.map(([, value]) => value.result), next] as const
      },
    )
    yield* Effect.forEach(
      waiting,
      (result) =>
        Deferred.fail(
          result,
          GatewayError.make({ kind: "disconnected", message: "Executor disconnected before returning a result" }),
        ),
      { discard: true },
    ).pipe(Effect.asVoid)
  })

  const complete = Effect.fn("ExecutorGateway.complete")(function* (
    socket: Socket,
    operationKey: string,
    response: CellResponse,
  ) {
    const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
    if (assignmentId === undefined) return
    const operation = yield* Ref.get(pending).pipe(
      Effect.map((current) => current.get(key(assignmentId, operationKey))),
    )
    if (operation === undefined || operation.socket !== socket) return
    const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId)))
    if (session === undefined || session.socket !== socket) return
    yield* Deferred.succeed(operation.result, { access: session.access, response })
  })

  const handle = Effect.fn("ExecutorGateway.handle")(function* (socket: Socket, message: HostMessageValue) {
    switch (message._tag) {
      case "ExecutorHello": {
        const welcome = yield* controller.hello(redactHello(message.hello))
        const sessionToken = Redacted.value(welcome.sessionToken)
        yield* register({
          socket,
          access: { version: 1, fence: welcome.fence, leaseEpoch: welcome.leaseEpoch, sessionToken },
        })
        socket.send(encode({ _tag: "ExecutorWelcome", welcome: { ...welcome, sessionToken } }))
        return
      }
      case "ExecutorReconnect": {
        const welcome = yield* controller.reconnect(redactAccess(message.access))
        yield* register({
          socket,
          access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
        })
        socket.send(encode({ _tag: "ExecutorReconnected", welcome }))
        return
      }
      case "ExecutorHeartbeat": {
        const receipt = yield* controller.heartbeat(redactHeartbeat(message.heartbeat))
        yield* register({
          socket,
          access: { ...message.heartbeat.access, leaseEpoch: receipt.leaseEpoch },
        })
        socket.send(encode({ _tag: "LeaseReceipt", receipt }))
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
            Effect.match({
              onFailure: (error) => failure(socket, message, error),
              onSuccess: () => undefined,
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
    const session = connected.value
    const result = yield* Deferred.make<ExecutionResult, GatewayError>()
    const pendingKey = key(input.assignmentId, input.operationKey)
    const operation = yield* Ref.modify(
      pending,
      (current): readonly [{ readonly pending: Pending; readonly send: boolean }, Map<string, Pending>] => {
        const known = current.get(pendingKey)
        if (known !== undefined) {
          const next = new Map(current)
          next.set(pendingKey, { ...known, waiters: known.waiters + 1 })
          return [{ pending: known, send: false }, next] as const
        }
        const next = new Map(current)
        const created = { socket: session.socket, result, waiters: 1 }
        next.set(pendingKey, created)
        return [{ pending: created, send: true }, next] as const
      },
    )
    const removePending = Ref.update(pending, (current) => {
      const known = current.get(pendingKey)
      if (known === undefined || known.result !== operation.pending.result) return current
      const next = new Map(current)
      if (known.waiters === 1) next.delete(pendingKey)
      else next.set(pendingKey, { ...known, waiters: known.waiters - 1 })
      return next
    })
    return yield* Effect.gen(function* () {
      if (operation.send)
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
        }).pipe(Effect.tapError((error) => Deferred.fail(operation.pending.result, error)))
      const completed = yield* Deferred.await(operation.pending.result).pipe(Effect.timeoutOption("60 seconds"))
      if (Option.isNone(completed))
        return yield* GatewayError.make({ kind: "timeout", message: "Executor operation did not finish in time" })
      return completed.value
    }).pipe(Effect.ensuring(removePending))
  })

  return { receive, disconnected, execute } satisfies Gateway
})
