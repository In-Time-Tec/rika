import { Deferred, Effect, Exit, FiberSet, Queue, Schema, Scope } from "effect"
import type { Gateway, Socket } from "../executor/gateway"

type SessionGateway = Pick<Gateway, "receive" | "disconnected" | "active">
export type WebSocketMessage = string | Buffer

export type Session = {
  readonly kind: "executor" | "runner" | "thread"
  readonly attach: (socket: Bun.ServerWebSocket<Session>) => void
  readonly receive: (socket: Socket, message: WebSocketMessage) => void
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly validate: () => Effect.Effect<boolean>
  readonly stopAdmission: () => void
  readonly drain: () => Effect.Effect<void>
  readonly close: (code?: number, reason?: string) => void
}

interface AuthoritySession {
  readonly validate: () => Effect.Effect<boolean>
  readonly close: (code?: number, reason?: string) => void
}

const maximumSessionMessages = 1024

export const pollAuthority = (sessions: ReadonlySet<AuthoritySession>) =>
  Effect.sleep("100 millis").pipe(
    Effect.andThen(
      Effect.suspend(() =>
        Effect.forEach(
          sessions,
          (current) =>
            current
              .validate()
              .pipe(
                Effect.tap((active) =>
                  active ? Effect.void : Effect.sync(() => current.close(1008, "authority revoked")),
                ),
              ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
    Effect.forever,
  )

const ownedSession = (handler: {
  readonly kind: Session["kind"]
  readonly opened?: (socket: Socket) => Effect.Effect<void>
  readonly receive: (socket: Socket, message: WebSocketMessage) => Effect.Effect<void>
  readonly disconnected: (socket: Socket | undefined) => Effect.Effect<void>
  readonly active: (socket: Socket) => Effect.Effect<boolean>
  readonly durable?: (message: WebSocketMessage) => boolean
  readonly concurrent?: (message: WebSocketMessage) => boolean
  readonly runConcurrent?: (effect: Effect.Effect<void>) => void
  readonly maximumQueuedBytes?: number
}): Session => {
  const scope = Scope.makeUnsafe("parallel")
  const fibers = Effect.runSync(FiberSet.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope)))
  const run = Effect.runSync(FiberSet.runtime(fibers)<never>())
  const serial = Effect.runSync(Queue.bounded<Effect.Effect<void>>(maximumSessionMessages))
  run(
    Queue.take(serial).pipe(
      Effect.flatMap((receive) => receive),
      Effect.forever,
    ),
  )
  const closed = Deferred.makeUnsafe<void>()
  let activeSocket: Bun.ServerWebSocket<Session> | undefined
  let accepting = true
  let closing = false
  let queuedBytes = 0
  let durableReceives = 0
  const durableDrained = Deferred.makeUnsafe<void>()
  const runDurable = (receive: Effect.Effect<void>) =>
    Effect.suspend(() => {
      durableReceives += 1
      const processed = Deferred.makeUnsafe<void>()
      ;(handler.runConcurrent ?? run)(
        receive.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              durableReceives -= 1
            }).pipe(
              Effect.andThen(Deferred.succeed(processed, undefined)),
              Effect.andThen(
                Effect.suspend(() =>
                  closing && durableReceives === 0 ? Deferred.succeed(durableDrained, undefined) : Effect.void,
                ),
              ),
            ),
          ),
        ),
      )
      return Deferred.await(processed)
    })
  const stop = (socket: Socket | undefined) =>
    Effect.suspend(() => {
      accepting = false
      if (closing) return Deferred.await(closed)
      closing = true
      return Scope.close(scope, Exit.void).pipe(
        Effect.andThen(Effect.suspend(() => (durableReceives === 0 ? Effect.void : Deferred.await(durableDrained)))),
        Effect.andThen(handler.disconnected(socket)),
        Effect.ensuring(Deferred.succeed(closed, undefined)),
      )
    })
  return {
    kind: handler.kind,
    attach: (socket) => {
      activeSocket = socket
      if (handler.opened !== undefined) run(handler.opened(socket))
    },
    receive: (socket, message) => {
      if (!accepting) return
      const bytes = Buffer.byteLength(message)
      if (handler.maximumQueuedBytes !== undefined && queuedBytes + bytes > handler.maximumQueuedBytes) {
        accepting = false
        socket.close(1013, "session byte limit exceeded")
        return
      }
      queuedBytes += bytes
      const receive = handler.receive(socket, message).pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            queuedBytes -= bytes
          }),
        ),
      )
      const owned = handler.durable?.(message) === true ? runDurable(receive) : receive
      if (handler.concurrent?.(message) === true) (handler.runConcurrent ?? run)(owned)
      else if (!Queue.offerUnsafe(serial, owned)) {
        queuedBytes -= bytes
        accepting = false
        socket.close(1013, "session overloaded")
      }
    },
    disconnected: (socket) => {
      accepting = false
      return stop(socket)
    },
    validate: () =>
      Effect.suspend(() =>
        !accepting || activeSocket === undefined
          ? Effect.succeed(true)
          : handler.active(activeSocket).pipe(Effect.orElseSucceed(() => false)),
      ),
    stopAdmission: () => {
      accepting = false
    },
    drain: () => Effect.suspend(() => stop(activeSocket)),
    close: (code = 1001, reason = "server draining") => activeSocket?.close(code, reason),
  }
}

const ReverseMessage = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literals(["MachineResult", "ExecutorConnectionFailed"]),
    payload: Schema.optional(Schema.Unknown),
  }),
)
const decodeReverseMessage = Schema.decodeUnknownExit(ReverseMessage)
const reverse = (message: WebSocketMessage) =>
  Exit.isSuccess(decodeReverseMessage(Buffer.from(message).toString("utf8")))

const gatewaySession = (
  kind: "executor" | "runner",
  gateway: SessionGateway,
  runConcurrent: (effect: Effect.Effect<void>) => void,
): Session =>
  ownedSession({
    kind,
    receive: gateway.receive,
    disconnected: (socket) => (socket === undefined ? Effect.void : gateway.disconnected(socket)),
    active: gateway.active,
    durable: () => false,
    concurrent: reverse,
    runConcurrent,
  })

export const sessionTransport = {
  gateway: gatewaySession,
  maximumMessages: maximumSessionMessages,
  owned: ownedSession,
}
