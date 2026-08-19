import { Context, Effect, Layer, Redacted, Ref } from "effect"
import {
  ExecutorProtocolError,
  type ExecutorAccessWire,
  type ExecutorCursor,
  type ExecutorFence,
  type ExecutorHeartbeatWire,
  type ExecutorHelloWire,
  type ExecutorReconnectWelcomeWire,
  type ExecutorSessionWire,
  type ExecutorWelcomeWire,
  type LeaseReceiptWire,
} from "./protocol"

export interface Options {
  readonly fence: ExecutorFence
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly restoredSession?: ExecutorSessionWire
}

interface Session {
  readonly token: Redacted.Redacted<string>
  readonly heartbeatIntervalMillis: number
  readonly cursor: ExecutorCursor
}

export interface Interface {
  readonly hasSession: Effect.Effect<boolean>
  readonly hello: Effect.Effect<ExecutorHelloWire, ExecutorProtocolError>
  readonly welcome: (welcome: ExecutorWelcomeWire) => Effect.Effect<void, ExecutorProtocolError>
  readonly reconnect: Effect.Effect<ExecutorAccessWire, ExecutorProtocolError>
  readonly reconnected: (welcome: ExecutorReconnectWelcomeWire) => Effect.Effect<void, ExecutorProtocolError>
  readonly heartbeat: (cursor: ExecutorCursor) => Effect.Effect<ExecutorHeartbeatWire, ExecutorProtocolError>
  readonly receipt: (receipt: LeaseReceiptWire) => Effect.Effect<void, ExecutorProtocolError>
  readonly access: Effect.Effect<ExecutorAccessWire, ExecutorProtocolError>
  readonly cursor: Effect.Effect<ExecutorCursor, ExecutorProtocolError>
  readonly persistedSession: Effect.Effect<ExecutorSessionWire, ExecutorProtocolError>
}

export class ExecutorRuntime extends Context.Service<ExecutorRuntime, Interface>()(
  "@rika/remote-execution/executor-runtime/ExecutorRuntime",
) {}

const sameFence = (left: ExecutorFence, right: ExecutorFence) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.generation === right.generation &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId

const fenced = ExecutorProtocolError.make({
  kind: "fenced",
  message: "Controller message has a different executor fence",
})
const disconnected = ExecutorProtocolError.make({ kind: "phase", message: "Executor session is not connected" })

export const layer = (options: Options): Layer.Layer<ExecutorRuntime, ExecutorProtocolError> =>
  Layer.effect(
    ExecutorRuntime,
    Effect.gen(function* () {
      if (options.restoredSession !== undefined && !sameFence(options.fence, options.restoredSession.fence))
        return yield* fenced
      const restored =
        options.restoredSession === undefined
          ? undefined
          : {
              token: Redacted.make(options.restoredSession.sessionToken, { label: "executor-session" }),
              heartbeatIntervalMillis: options.restoredSession.heartbeatIntervalMillis,
              cursor: options.restoredSession.cursor,
            }
      const session = yield* Ref.make<Session | undefined>(restored)

      const connected = Effect.fn("ExecutorRuntime.connected")(function* () {
        const current = yield* Ref.get(session)
        return current === undefined ? yield* disconnected : current
      })

      const access = Effect.gen(function* () {
        const current = yield* connected()
        return {
          version: 1 as const,
          fence: options.fence,
          sessionToken: Redacted.value(current.token),
        }
      })

      const hello = Effect.gen(function* () {
        if ((yield* Ref.get(session)) !== undefined)
          return yield* ExecutorProtocolError.make({
            kind: "phase",
            message: "Bootstrap cannot be replayed after welcome",
          })
        return {
          version: 1 as const,
          fence: options.fence,
          bootstrapToken: Redacted.value(options.bootstrapToken),
        }
      })

      const welcome = Effect.fn("ExecutorRuntime.welcome")(function* (input: ExecutorWelcomeWire) {
        if (!sameFence(options.fence, input.fence)) return yield* fenced
        if ((yield* Ref.get(session)) !== undefined)
          return yield* ExecutorProtocolError.make({ kind: "phase", message: "Executor session is already connected" })
        yield* Ref.set(session, {
          token: Redacted.make(input.sessionToken, { label: "executor-session" }),
          heartbeatIntervalMillis: input.heartbeatIntervalMillis,
          cursor: input.cursor,
        })
      })

      const reconnect = access

      const reconnected = Effect.fn("ExecutorRuntime.reconnected")(function* (input: ExecutorReconnectWelcomeWire) {
        if (!sameFence(options.fence, input.fence)) return yield* fenced
        const current = yield* connected()
        if (input.cursor.sequence < current.cursor.sequence)
          return yield* ExecutorProtocolError.make({ kind: "cursor", message: "Reconnect replayed an older cursor" })
        if (input.cursor.sequence === current.cursor.sequence && input.cursor.value !== current.cursor.value)
          return yield* ExecutorProtocolError.make({
            kind: "cursor",
            message: "Reconnect cursor conflicts at the same sequence",
          })
        yield* Ref.set(session, {
          ...current,
          heartbeatIntervalMillis: input.heartbeatIntervalMillis,
          cursor: input.cursor,
        })
      })

      const heartbeat = Effect.fn("ExecutorRuntime.heartbeat")(function* (cursor: ExecutorCursor) {
        const current = yield* connected()
        if (cursor.sequence < current.cursor.sequence)
          return yield* ExecutorProtocolError.make({ kind: "cursor", message: "Executor cursor cannot move backwards" })
        if (cursor.sequence === current.cursor.sequence && cursor.value !== current.cursor.value)
          return yield* ExecutorProtocolError.make({
            kind: "cursor",
            message: "Executor cursor conflicts at the same sequence",
          })
        return { version: 1 as const, access: yield* access, cursor }
      })

      const receipt = Effect.fn("ExecutorRuntime.receipt")(function* (input: LeaseReceiptWire) {
        if (!sameFence(options.fence, input.fence)) return yield* fenced
        const current = yield* connected()
        if (input.cursor.sequence < current.cursor.sequence)
          return yield* ExecutorProtocolError.make({
            kind: "cursor",
            message: "Lease receipt replayed an older cursor",
          })
        if (input.cursor.sequence === current.cursor.sequence && input.cursor.value !== current.cursor.value)
          return yield* ExecutorProtocolError.make({
            kind: "cursor",
            message: "Lease receipt cursor conflicts at the same sequence",
          })
        yield* Ref.set(session, { ...current, cursor: input.cursor })
      })

      const cursor = Effect.map(connected(), (current) => current.cursor)
      const hasSession = Effect.map(Ref.get(session), (current) => current !== undefined)
      const persistedSession = Effect.map(connected(), (current) => ({
        version: 1 as const,
        fence: options.fence,
        sessionToken: Redacted.value(current.token),
        heartbeatIntervalMillis: current.heartbeatIntervalMillis,
        cursor: current.cursor,
      }))

      return ExecutorRuntime.of({
        hasSession,
        hello,
        welcome,
        reconnect,
        reconnected,
        heartbeat,
        receipt,
        access,
        cursor,
        persistedSession,
      })
    }),
  )
