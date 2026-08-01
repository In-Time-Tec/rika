import {
  Context,
  Crypto,
  Effect,
  Encoding,
  FiberSet,
  FileSystem,
  Function,
  Layer,
  Path,
  Ref,
  Runtime,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Feed from "./resident-interactive-feed"
import * as Request from "./resident-operation-request"
import * as Handshake from "./resident-service-handshake"
import { OperationUnavailable } from "../operation/contract/product-operation-errors"
import type { Interface as OperationInterface } from "../operation/contract/product-operation-service"
import { Input } from "../operation/contract/product-operation"
import type { InteractiveSession } from "../operation/interactive/interactive-session"

const ClientMessage = Schema.Union([
  Handshake.HandshakeProtocol.Handshake,
  Request.OperationRequestProtocol.Ping,
  Request.OperationRequestProtocol.OperationRequest,
  Feed.InteractiveFeedProtocol.InteractiveCommandRequest,
  Feed.InteractiveFeedProtocol.CancelInteractiveCommand,
  Feed.InteractiveFeedProtocol.InteractiveFeedAck,
  Feed.InteractiveFeedProtocol.InteractiveFeedReplay,
  Feed.InteractiveFeedProtocol.InteractiveEnd,
  Request.OperationRequestProtocol.CancelRequest,
])
const ServerMessage = Schema.Union([
  Handshake.HandshakeProtocol.HandshakeAccepted,
  Handshake.HandshakeProtocol.HandshakeIncompatible,
  Handshake.HandshakeProtocol.HandshakeRejected,
  Request.OperationRequestProtocol.Pong,
  Request.OperationRequestProtocol.Output,
  Feed.InteractiveFeedProtocol.InteractiveStarted,
  Feed.InteractiveFeedProtocol.InteractiveFeedEvent,
  Feed.InteractiveFeedProtocol.InteractiveFeedResync,
  Feed.InteractiveFeedProtocol.InteractiveCommandCompleted,
  Feed.InteractiveFeedProtocol.InteractiveCommandFailed,
  Request.OperationRequestProtocol.OperationCompleted,
  Request.OperationRequestProtocol.OperationFailed,
])
type ClientMessage = typeof ClientMessage.Type
type ServerMessage = typeof ServerMessage.Type

class ResidentServiceError extends Schema.TaggedErrorClass<ResidentServiceError>()("ResidentServiceError", {
  reason: Schema.Literals([
    "authentication-failed",
    "identity-mismatch",
    "incompatible-resident",
    "foreign-listener",
    "message-too-large",
    "replacement-delayed",
    "resident-absent",
    "resident-draining",
    "startup-failed",
    "transport-failed",
    "unsafe-token",
  ]),
  message: Schema.String,
  residentPid: Schema.optionalKey(Schema.Int),
}) {}

const runtimeRestartExitCode = 75
class ResidentRestartRequired extends Schema.TaggedErrorClass<ResidentRestartRequired>()("ResidentRestartRequired", {
  message: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
}) {
  override readonly [Runtime.errorExitCode] = runtimeRestartExitCode
  override readonly [Runtime.errorReported] = false
}

interface Connection {
  readonly role: "owner" | "attached"
  readonly endpoint: string
  readonly connectionId: string
  readonly ping: Effect.Effect<void, ResidentServiceError>
  readonly run: (
    input: Input,
    options?: {
      readonly stdout?: (text: string) => Effect.Effect<void>
      readonly stderr?: (text: string) => Effect.Effect<void>
      readonly interactive?: (
        input: Feed.InteractiveInput,
        session: InteractiveSession,
      ) => Effect.Effect<void, OperationUnavailable>
    },
  ) => Effect.Effect<void, OperationUnavailable | ResidentServiceError | ResidentRestartRequired>
  readonly closed: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}
interface StartedHost {
  readonly pid: number
  readonly startup: Effect.Effect<void, ResidentServiceError>
  readonly detach: Effect.Effect<void, ResidentServiceError>
  readonly abort: Effect.Effect<void>
}
type Owner = (
  interactive: (input: Feed.InteractiveInput, session: InteractiveSession) => Effect.Effect<void, OperationUnavailable>,
) => Effect.Effect<OperationInterface, ResidentServiceError, Scope.Scope>
interface Interface {
  readonly getOrCreate: (options: {
    readonly profile: string
    readonly dataRoot: string
    readonly clientKind: Handshake.Handshake["clientKind"]
    readonly graceMilliseconds?: number
    readonly allowSupersede?: boolean
    readonly startHost?: () => Effect.Effect<
      StartedHost,
      ResidentServiceError,
      ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
    >
  }) => Effect.Effect<
    Connection,
    ResidentServiceError | ResidentRestartRequired,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >
}
class Service extends Context.Service<Service, Interface>()("@rika/product/resident/resident-service/Service") {}
const testLayer = (implementation: Interface): Layer.Layer<Service> => Layer.succeed(Service, implementation)

const canonicalServiceIdentity: {
  (
    canonicalDataRoot: string,
  ): (profile: string) => Effect.Effect<string, import("effect/PlatformError").PlatformError, Crypto.Crypto>
  (
    profile: string,
    canonicalDataRoot: string,
  ): Effect.Effect<string, import("effect/PlatformError").PlatformError, Crypto.Crypto>
} = Function.dual(2, (profile: string, canonicalDataRoot: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const bytes = new TextEncoder().encode(`${profile}\0${canonicalDataRoot}`)
    return Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes))
  }),
)

type LifecycleState = "starting" | "ready" | "grace" | "draining" | "stopped"
type LifecycleValue = { state: LifecycleState; clients: number; graceGeneration: number; replacementWork: number }
const makeLifecycle = (changed: (state: LifecycleState) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const value = yield* Ref.make<LifecycleValue>({
      state: "starting",
      clients: 0,
      graceGeneration: 0,
      replacementWork: 0,
    })
    const admission = yield* Semaphore.make(1)
    const transition = (update: (current: LifecycleValue) => LifecycleValue) =>
      Ref.modify(value, (current) => {
        const next = update(current)
        return [next.state === current.state ? undefined : next.state, next] as const
      }).pipe(Effect.flatMap((state) => (state === undefined ? Effect.void : changed(state))))
    return {
      state: Ref.get(value).pipe(Effect.map((current) => current.state)),
      soleClient: Ref.get(value).pipe(
        Effect.map((current) => current.clients <= 1 && current.state !== "draining" && current.state !== "stopped"),
      ),
      graceHolds: (generation: number) =>
        Ref.get(value).pipe(
          Effect.map(
            (current) => current.state === "grace" && current.clients === 0 && current.graceGeneration === generation,
          ),
        ),
      ready: Ref.modify(value, (current) => {
        if (current.state !== "starting") return [undefined, current] as const
        const next =
          current.clients === 0
            ? { ...current, state: "grace" as const, clients: 0, graceGeneration: current.graceGeneration + 1 }
            : { ...current, state: "ready" as const }
        return [next.state === "grace" ? next.graceGeneration : undefined, next] as const
      }).pipe(Effect.tap((generation) => changed(generation === undefined ? "ready" : "grace"))),
      tryAttach: admission.withPermits(1)(
        Ref.modify(
          value,
          (current): readonly [{ readonly attached: boolean; readonly changed: boolean }, LifecycleValue] => {
            if (current.state === "draining" || current.state === "stopped")
              return [{ attached: false, changed: false }, current] as const
            const state = current.state === "grace" ? "ready" : current.state
            return [
              { attached: true, changed: state !== current.state },
              { ...current, state, clients: current.clients + 1, graceGeneration: current.graceGeneration + 1 },
            ] as const
          },
        ).pipe(
          Effect.tap((result) => (result.changed === true ? changed("ready") : Effect.void)),
          Effect.map((result) => result.attached),
        ),
      ),
      detach: Ref.modify(value, (current) => {
        const clients = Math.max(0, current.clients - 1)
        const entersGrace = clients === 0 && current.state === "ready"
        const next = entersGrace
          ? { ...current, state: "grace" as const, clients, graceGeneration: current.graceGeneration + 1 }
          : { ...current, clients }
        return [entersGrace ? next.graceGeneration : undefined, next] as const
      }).pipe(Effect.tap((generation) => (generation === undefined ? Effect.void : changed("grace")))),
      expireGrace: (generation: number) =>
        admission
          .withPermits(1)(
            Ref.modify(value, (current) => {
              if (current.state !== "grace" || current.clients !== 0 || current.graceGeneration !== generation)
                return [false, current] as const
              return [true, { ...current, state: "draining" as const }] as const
            }),
          )
          .pipe(Effect.tap((draining) => (draining === true ? changed("draining") : Effect.void))),
      reserveReplacementWork: admission.withPermits(1)(
        Ref.modify(value, (current) => {
          if (current.state === "draining" || current.state === "stopped") return [undefined, current] as const
          let released = false
          const release = Effect.suspend(() => {
            if (released) return Effect.void
            released = true
            return Ref.update(value, (state) => ({
              ...state,
              replacementWork: Math.max(0, state.replacementWork - 1),
            }))
          })
          return [release, { ...current, replacementWork: current.replacementWork + 1 }] as const
        }),
      ),
      runWork: <A, E, R>(
        fibers: FiberSet.FiberSet<A, E>,
        work: Effect.Effect<A, E, R>,
        replacementRelevant: boolean = true,
      ) =>
        admission.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(value)
            if (current.state === "draining" || current.state === "stopped") return undefined
            if (replacementRelevant)
              yield* Ref.update(value, (state) => ({ ...state, replacementWork: state.replacementWork + 1 }))
            const release = replacementRelevant
              ? Ref.update(value, (state) => ({
                  ...state,
                  replacementWork: Math.max(0, state.replacementWork - 1),
                }))
              : Effect.void
            return yield* FiberSet.run(fibers, work.pipe(Effect.ensuring(release)))
          }),
        ),
      authorizeReplacement: (hasActiveExecutionWork: Effect.Effect<boolean>) =>
        admission.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(value)
            if (current.state === "draining" || current.state === "stopped") return "supersede" as const
            if (current.replacementWork > 0 || (yield* hasActiveExecutionWork)) return "defer" as const
            yield* transition((state) => ({ ...state, state: "draining" }))
            return "supersede" as const
          }).pipe(Effect.uninterruptible),
        ),
      beginDrain: admission.withPermits(1)(
        transition((current) => (current.state === "stopped" ? current : { ...current, state: "draining" })),
      ),
      stopped: transition((current) => ({ ...current, state: "stopped", clients: 0 })),
    }
  })

const ServiceRuntime = { runtimeRestartExitCode, testLayer, canonicalServiceIdentity, makeLifecycle } as const

export { ClientMessage, ServerMessage, ResidentServiceError, ResidentRestartRequired, Service, ServiceRuntime }
export type { Connection, StartedHost, Owner, Interface, OperationInterface, LifecycleState }
