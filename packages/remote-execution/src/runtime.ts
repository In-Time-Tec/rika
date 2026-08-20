import { Context, Effect, Layer, Redacted, Ref } from "effect"
import {
  type AccessWire,
  type Capabilities,
  type Cursor,
  type Fence,
  type HeartbeatWire,
  type HelloWire,
  ProtocolError,
  type ReceiptWire,
  type ReconnectWelcomeWire,
  type ResumeCursors,
  type SessionWire,
  type WelcomeWire,
} from "./protocol"

export interface Options {
  readonly fence: Fence
  readonly bootstrapToken: Redacted.Redacted<string>
  readonly templateBuildId: string | null
  readonly capabilities: Capabilities
  readonly cursors: ResumeCursors
  readonly latestCheckpointId: string | null
  readonly restoredSession?: SessionWire
}

interface Session {
  readonly token: Redacted.Redacted<string>
  readonly leaseEpoch: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: Cursor
}

export interface Interface {
  readonly hasSession: Effect.Effect<boolean>
  readonly hello: Effect.Effect<HelloWire, ProtocolError>
  readonly welcome: (welcome: WelcomeWire) => Effect.Effect<void, ProtocolError>
  readonly reconnect: Effect.Effect<AccessWire, ProtocolError>
  readonly reconnected: (welcome: ReconnectWelcomeWire) => Effect.Effect<void, ProtocolError>
  readonly heartbeat: (cursor: Cursor) => Effect.Effect<HeartbeatWire, ProtocolError>
  readonly receipt: (receipt: ReceiptWire) => Effect.Effect<void, ProtocolError>
  readonly access: Effect.Effect<AccessWire, ProtocolError>
  readonly cursor: Effect.Effect<Cursor, ProtocolError>
  readonly persistedSession: Effect.Effect<SessionWire, ProtocolError>
}

export class Runtime extends Context.Service<Runtime, Interface>()("@rika/remote-execution/runtime") {}

const sameFence = (left: Fence, right: Fence) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.assignmentGeneration === right.assignmentGeneration &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId &&
  left.processIncarnation === right.processIncarnation

const fenced = ProtocolError.make({
  kind: "fenced",
  message: "Controller message has a different executor fence",
})
const disconnected = ProtocolError.make({ kind: "phase", message: "Executor session is not connected" })

export const layer = (options: Options): Layer.Layer<Runtime, ProtocolError> =>
  Layer.effect(
    Runtime,
    Effect.gen(function* () {
      if (options.restoredSession !== undefined && !sameFence(options.fence, options.restoredSession.fence))
        return yield* fenced
      const restored =
        options.restoredSession === undefined
          ? undefined
          : {
              token: Redacted.make(options.restoredSession.sessionToken, { label: "executor-session" }),
              leaseEpoch: options.restoredSession.leaseEpoch,
              heartbeatIntervalMillis: options.restoredSession.heartbeatIntervalMillis,
              cursor: options.restoredSession.cursor,
            }
      const session = yield* Ref.make<Session | undefined>(restored)

      const connected = Effect.fn("Runtime.connected")(function* () {
        const current = yield* Ref.get(session)
        return current === undefined ? yield* disconnected : current
      })

      const access = Effect.gen(function* () {
        const current = yield* connected()
        return {
          version: 1 as const,
          fence: options.fence,
          leaseEpoch: current.leaseEpoch,
          sessionToken: Redacted.value(current.token),
        }
      })

      const hello = Effect.gen(function* () {
        if ((yield* Ref.get(session)) !== undefined)
          return yield* ProtocolError.make({
            kind: "phase",
            message: "Bootstrap cannot be replayed after welcome",
          })
        return {
          minimumVersion: 1 as const,
          maximumVersion: 1 as const,
          fence: options.fence,
          templateBuildId: options.templateBuildId,
          capabilities: options.capabilities,
          cursors: options.cursors,
          latestCheckpointId: options.latestCheckpointId,
          bootstrapToken: Redacted.value(options.bootstrapToken),
        }
      })

      const welcome = Effect.fn("Runtime.welcome")(function* (input: WelcomeWire) {
        if (!sameFence(options.fence, input.fence)) return yield* fenced
        if ((yield* Ref.get(session)) !== undefined)
          return yield* ProtocolError.make({ kind: "phase", message: "Executor session is already connected" })
        yield* Ref.set(session, {
          token: Redacted.make(input.sessionToken, { label: "executor-session" }),
          leaseEpoch: input.leaseEpoch,
          heartbeatIntervalMillis: input.heartbeatIntervalMillis,
          cursor: input.cursor,
        })
      })

      const reconnect = access

      const reconnected = Effect.fn("Runtime.reconnected")(function* (input: ReconnectWelcomeWire) {
        if (!sameFence(options.fence, input.fence)) return yield* fenced
        const current = yield* connected()
        if (input.leaseEpoch <= current.leaseEpoch)
          return yield* ProtocolError.make({
            kind: "fenced",
            message: "Reconnect did not advance the lease epoch",
          })
        if (input.cursor.sequence < current.cursor.sequence)
          return yield* ProtocolError.make({ kind: "cursor", message: "Reconnect replayed an older cursor" })
        if (input.cursor.sequence === current.cursor.sequence && input.cursor.value !== current.cursor.value)
          return yield* ProtocolError.make({
            kind: "cursor",
            message: "Reconnect cursor conflicts at the same sequence",
          })
        yield* Ref.set(session, {
          ...current,
          leaseEpoch: input.leaseEpoch,
          heartbeatIntervalMillis: input.heartbeatIntervalMillis,
          cursor: input.cursor,
        })
      })

      const heartbeat = Effect.fn("Runtime.heartbeat")(function* (cursor: Cursor) {
        const current = yield* connected()
        if (cursor.sequence < current.cursor.sequence)
          return yield* ProtocolError.make({ kind: "cursor", message: "Executor cursor cannot move backwards" })
        if (cursor.sequence === current.cursor.sequence && cursor.value !== current.cursor.value)
          return yield* ProtocolError.make({
            kind: "cursor",
            message: "Executor cursor conflicts at the same sequence",
          })
        return { version: 1 as const, access: yield* access, cursor }
      })

      const receipt = Effect.fn("Runtime.receipt")(function* (input: ReceiptWire) {
        if (!sameFence(options.fence, input.fence)) return yield* fenced
        const current = yield* connected()
        if (input.leaseEpoch !== current.leaseEpoch)
          return yield* ProtocolError.make({ kind: "fenced", message: "Lease receipt epoch is stale" })
        if (input.cursor.sequence < current.cursor.sequence)
          return yield* ProtocolError.make({
            kind: "cursor",
            message: "Lease receipt replayed an older cursor",
          })
        if (input.cursor.sequence === current.cursor.sequence && input.cursor.value !== current.cursor.value)
          return yield* ProtocolError.make({
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
        leaseEpoch: current.leaseEpoch,
        sessionToken: Redacted.value(current.token),
        heartbeatIntervalMillis: current.heartbeatIntervalMillis,
        cursor: current.cursor,
      }))

      return Runtime.of({
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
