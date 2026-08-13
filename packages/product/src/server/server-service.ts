import {
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  FiberSet,
  FileSystem,
  Function,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Feed from "./server-interactive-feed"
import * as Request from "./server-operation-request"
import * as Handshake from "./server-service-handshake"
import type * as InteractiveConnection from "./server-interactive-connection"
import { OperationUnavailable } from "../operation/contract/product-operation"
import { Input } from "../operation/contract/product-operation"
import type { InteractiveSession } from "../operation/interactive/session"

const ClientMessage = Schema.Union([
  Handshake.HandshakeProtocol.Handshake,
  Request.OperationRequestProtocol.Ping,
  Request.OperationRequestProtocol.OperationRequest,
  Feed.InteractiveFeedProtocol.InteractiveCommandRequest,
  Feed.InteractiveFeedProtocol.CancelInteractiveCommand,
  Feed.InteractiveFeedProtocol.InteractiveFeedAck,
  Feed.InteractiveFeedProtocol.InteractiveEnd,
  Request.OperationRequestProtocol.CancelRequest,
])
const ServerMessage = Schema.Union([
  Handshake.HandshakeProtocol.HandshakeAccepted,
  Handshake.HandshakeProtocol.HandshakeBuildMismatch,
  Handshake.HandshakeProtocol.HandshakeRejected,
  Request.OperationRequestProtocol.Pong,
  Request.OperationRequestProtocol.Output,
  Feed.InteractiveFeedProtocol.InteractiveStarted,
  Feed.InteractiveFeedProtocol.InteractiveFeedEvent,
  Feed.InteractiveFeedProtocol.InteractiveCommandCompleted,
  Feed.InteractiveFeedProtocol.InteractiveCommandFailed,
  Request.OperationRequestProtocol.OperationCompleted,
  Request.OperationRequestProtocol.OperationFailed,
])
type ClientMessage = typeof ClientMessage.Type
type ServerMessage = typeof ServerMessage.Type

class ServerServiceError extends Schema.TaggedErrorClass<ServerServiceError>()("ServerServiceError", {
  reason: Schema.Literals([
    "authentication-failed",
    "identity-mismatch",
    "foreign-listener",
    "message-too-large",
    "replacement-required",
    "server-absent",
    "server-draining",
    "startup-failed",
    "transport-failed",
    "unsafe-token",
  ]),
  message: Schema.String,
  serverPid: Schema.optionalKey(Schema.Int),
}) {}

export interface Connection {
  readonly role: "owner" | "attached"
  readonly endpoint: string
  readonly connectionId: string
  readonly ping: Effect.Effect<void, ServerServiceError>
  readonly run: (
    input: Input,
    options?: {
      readonly stdout?: (text: string) => Effect.Effect<void>
      readonly stderr?: (text: string) => Effect.Effect<void>
      readonly interactive?: (
        input: Feed.InteractiveInput,
        session: InteractiveSession,
        connection: InteractiveConnection.Connection,
      ) => Effect.Effect<void, OperationUnavailable>
    },
  ) => Effect.Effect<void, OperationUnavailable | ServerServiceError>
  readonly closed: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}
export interface StartedHost {
  readonly pid: number
  readonly startup: Effect.Effect<void, ServerServiceError>
  readonly detach: Effect.Effect<void, ServerServiceError>
  readonly abort: Effect.Effect<void>
}
interface Interface {
  readonly getOrCreate: (options: {
    readonly profile: string
    readonly dataRoot: string
    readonly clientKind: Handshake.Handshake["clientKind"]
    readonly graceMilliseconds?: number
    readonly startHost?: () => Effect.Effect<
      StartedHost,
      ServerServiceError,
      ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
    >
  }) => Effect.Effect<
    Connection,
    ServerServiceError,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >
}
class Service extends Context.Service<Service, Interface>()("@rika/product/server/server-service/Service") {}
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
type LifecycleValue = { state: LifecycleState; clients: number; graceGeneration: number; transientWork: number }
const makeLifecycle = (changed: (state: LifecycleState) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const value = yield* Ref.make<LifecycleValue>({
      state: "starting",
      clients: 0,
      graceGeneration: 0,
      transientWork: 0,
    })
    const admission = yield* Semaphore.make(1)
    const drained = yield* Deferred.make<void>()
    const transition = (update: (current: LifecycleValue) => LifecycleValue) =>
      Ref.modify(value, (current) => {
        const next = update(current)
        return [next.state === current.state ? undefined : next.state, next] as const
      }).pipe(Effect.flatMap((state) => (state === undefined ? Effect.void : changed(state))))
    const releaseTransientWork = Ref.modify(value, (current) => {
      const next = { ...current, transientWork: Math.max(0, current.transientWork - 1) }
      return [next.state === "draining" && next.transientWork === 0, next] as const
    }).pipe(Effect.flatMap((complete) => (complete ? Deferred.succeed(drained, undefined) : Effect.void)))
    const enterDrain = transition((current) =>
      current.state === "stopped" ? current : { ...current, state: "draining" },
    ).pipe(
      Effect.andThen(Ref.get(value)),
      Effect.flatMap((current) =>
        current.state === "draining" && current.transientWork === 0
          ? Deferred.succeed(drained, undefined)
          : Effect.void,
      ),
    )
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
        if (current.state !== "starting") return [Option.none<number | undefined>(), current] as const
        const next =
          current.clients === 0
            ? { ...current, state: "grace" as const, clients: 0, graceGeneration: current.graceGeneration + 1 }
            : { ...current, state: "ready" as const }
        return [Option.some(next.state === "grace" ? next.graceGeneration : undefined), next] as const
      }).pipe(
        Effect.tap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (generation) => changed(generation === undefined ? "ready" : "grace"),
          }),
        ),
        Effect.map(Option.getOrUndefined),
      ),
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
      reserveTransientWork: admission.withPermits(1)(
        Ref.modify(value, (current) => {
          if (current.state === "draining" || current.state === "stopped") return [undefined, current] as const
          let released = false
          const release = Effect.suspend(() => {
            if (released) return Effect.void
            released = true
            return releaseTransientWork
          })
          return [release, { ...current, transientWork: current.transientWork + 1 }] as const
        }),
      ),
      runWork: <A, E, R>(
        fibers: FiberSet.FiberSet<A, E>,
        work: Effect.Effect<A, E, R>,
        drainRelevant: boolean = true,
      ) =>
        admission.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(value)
            if (current.state === "draining" || current.state === "stopped") return undefined
            if (drainRelevant)
              yield* Ref.update(value, (state) => ({ ...state, transientWork: state.transientWork + 1 }))
            const release = drainRelevant ? releaseTransientWork : Effect.void
            return yield* FiberSet.run(fibers, work.pipe(Effect.ensuring(release)))
          }),
        ),
      drainForReplacement: (prepare: Effect.Effect<void>) =>
        admission
          .withPermits(1)(enterDrain.pipe(Effect.andThen(prepare), Effect.uninterruptible))
          .pipe(Effect.andThen(Deferred.await(drained))),
      beginDrain: admission.withPermits(1)(enterDrain),
      stopped: transition((current) => ({ ...current, state: "stopped", clients: 0 })),
    }
  })

const ServiceRuntime = { testLayer, canonicalServiceIdentity, makeLifecycle } as const

export { ClientMessage, ServerMessage, ServerServiceError, Service, ServiceRuntime }
