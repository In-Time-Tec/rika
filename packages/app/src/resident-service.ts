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
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { Input, OperationUnavailable } from "./operation"
import type { InteractiveSession, Interface as OperationInterface } from "./operation"

export type InteractiveInput = Extract<Input, { readonly _tag: "Interactive" }>

export const protocolVersion = { major: 1, minor: 0 } as const

export const ProtocolVersion = Schema.Struct({ major: Schema.Int, minor: Schema.Int })
export const ClientKind = Schema.Literals(["interactive", "run", "review", "workflow", "thread-continue", "product"])
export const Handshake = Schema.Struct({
  family: Schema.tag("rika-resident"),
  version: ProtocolVersion,
  identity: Schema.String,
  token: Schema.String,
  clientNonce: Schema.String,
  clientKind: ClientKind,
  clientVersion: Schema.String,
  capabilities: Schema.Array(Schema.String),
})
export type Handshake = typeof Handshake.Type

export const HandshakeAccepted = Schema.Struct({
  _tag: Schema.tag("accepted"),
  family: Schema.tag("rika-resident"),
  version: ProtocolVersion,
  identity: Schema.String,
  clientNonce: Schema.String,
  serviceNonce: Schema.String,
  connectionId: Schema.String,
  state: Schema.Literals(["starting", "ready", "grace"]),
  capabilities: Schema.Array(Schema.String),
})
export type HandshakeAccepted = typeof HandshakeAccepted.Type

export const HandshakeRejected = Schema.Struct({
  _tag: Schema.tag("rejected"),
  reason: Schema.Literal("draining"),
})
export type HandshakeRejected = typeof HandshakeRejected.Type

export const StartupReady = Schema.Struct({ _tag: Schema.tag("startup-ready") })
export const StartupFailed = Schema.Struct({
  _tag: Schema.tag("startup-failed"),
  error: Schema.String,
})

export const Ping = Schema.Struct({ _tag: Schema.tag("ping"), id: Schema.String })
export const Pong = Schema.Struct({ _tag: Schema.tag("pong"), id: Schema.String })
export const OperationRequest = Schema.Struct({
  _tag: Schema.tag("operation"),
  requestId: Schema.String,
  input: Input,
})
export const InteractiveAction = Schema.Struct({
  _tag: Schema.tag("interactive-action"),
  requestId: Schema.String,
  sessionId: Schema.String,
  actionId: Schema.String,
  method: Schema.String,
  arguments: Schema.Array(Schema.Unknown),
})
export const CancelInteractiveAction = Schema.Struct({
  _tag: Schema.tag("cancel-interactive-action"),
  requestId: Schema.String,
  sessionId: Schema.String,
  actionId: Schema.String,
})
export const InteractiveEnd = Schema.Struct({
  _tag: Schema.tag("interactive-end"),
  requestId: Schema.String,
  sessionId: Schema.String,
})
export const CancelRequest = Schema.Struct({ _tag: Schema.tag("cancel"), requestId: Schema.String })
export const ClientMessage = Schema.Union([
  Handshake,
  Ping,
  OperationRequest,
  InteractiveAction,
  CancelInteractiveAction,
  InteractiveEnd,
  CancelRequest,
])
export const Output = Schema.Struct({
  _tag: Schema.tag("output"),
  requestId: Schema.String,
  channel: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
})
export const InteractiveStarted = Schema.Struct({
  _tag: Schema.tag("interactive-started"),
  requestId: Schema.String,
  sessionId: Schema.String,
})
export const InteractiveEvent = Schema.Struct({
  _tag: Schema.tag("interactive-event"),
  requestId: Schema.String,
  sessionId: Schema.String,
  actionId: Schema.String,
  event: Schema.Unknown,
})
export const ActionCompleted = Schema.Struct({
  _tag: Schema.tag("action-completed"),
  requestId: Schema.String,
  sessionId: Schema.String,
  actionId: Schema.String,
})
export const ActionFailed = Schema.Struct({
  _tag: Schema.tag("action-failed"),
  requestId: Schema.String,
  sessionId: Schema.String,
  actionId: Schema.String,
  error: OperationUnavailable,
})
export const OperationCompleted = Schema.Struct({ _tag: Schema.tag("operation-completed"), requestId: Schema.String })
export const OperationFailed = Schema.Struct({
  _tag: Schema.tag("operation-failed"),
  requestId: Schema.String,
  error: OperationUnavailable,
})
export const ServerMessage = Schema.Union([
  HandshakeAccepted,
  HandshakeRejected,
  StartupReady,
  StartupFailed,
  Pong,
  Output,
  InteractiveStarted,
  InteractiveEvent,
  ActionCompleted,
  ActionFailed,
  OperationCompleted,
  OperationFailed,
])
export type ClientMessage = typeof ClientMessage.Type
export type ServerMessage = typeof ServerMessage.Type

export class ResidentServiceError extends Schema.TaggedErrorClass<ResidentServiceError>()("ResidentServiceError", {
  reason: Schema.Literals([
    "authentication-failed",
    "identity-mismatch",
    "upgrade-required",
    "capability-mismatch",
    "foreign-listener",
    "resident-absent",
    "resident-draining",
    "transport-failed",
    "unsafe-token",
  ]),
  message: Schema.String,
}) {}

export interface Connection {
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
        input: InteractiveInput,
        session: InteractiveSession,
      ) => Effect.Effect<void, OperationUnavailable>
    },
  ) => Effect.Effect<void, OperationUnavailable | ResidentServiceError>
  readonly closed: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export interface Interface {
  readonly getOrCreate: (options: {
    readonly profile: string
    readonly dataRoot: string
    readonly clientKind: Handshake["clientKind"]
    readonly clientVersion: string
    readonly graceMilliseconds?: number
    readonly startHost?: () => Effect.Effect<
      void,
      ResidentServiceError,
      ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
    >
    readonly owner?: (
      interactive: (input: InteractiveInput, session: InteractiveSession) => Effect.Effect<void, OperationUnavailable>,
    ) => Effect.Effect<OperationInterface, ResidentServiceError, Scope.Scope>
  }) => Effect.Effect<
    Connection,
    ResidentServiceError,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >
}

export class Service extends Context.Service<Service, Interface>()("@rika/app/resident-service/Service") {}

export const testLayer = (implementation: Interface): Layer.Layer<Service> => Layer.succeed(Service, implementation)

export const canonicalServiceIdentity: {
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

export type HandshakeResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "AuthenticationFailed" }
  | { readonly _tag: "IdentityMismatch" }
  | { readonly _tag: "UpgradeRequired" }
  | { readonly _tag: "CapabilityMismatch" }

export const validateHandshake: {
  (expected: {
    readonly identity: string
    readonly token: string
    readonly capabilities?: ReadonlyArray<string>
  }): (handshake: Handshake) => HandshakeResult
  (
    handshake: Handshake,
    expected: { readonly identity: string; readonly token: string; readonly capabilities?: ReadonlyArray<string> },
  ): HandshakeResult
} = Function.dual(
  2,
  (
    handshake: Handshake,
    expected: { readonly identity: string; readonly token: string; readonly capabilities?: ReadonlyArray<string> },
  ): HandshakeResult => {
    if (handshake.token !== expected.token) return { _tag: "AuthenticationFailed" }
    if (handshake.identity !== expected.identity) return { _tag: "IdentityMismatch" }
    if (handshake.version.major !== protocolVersion.major) return { _tag: "UpgradeRequired" }
    if ((expected.capabilities ?? []).some((capability) => !handshake.capabilities.includes(capability)))
      return { _tag: "CapabilityMismatch" }
    return { _tag: "Accepted" }
  },
)

export const negotiateCapabilities: {
  (remote: ReadonlyArray<string>): (local: ReadonlyArray<string>) => ReadonlyArray<string>
  (local: ReadonlyArray<string>, remote: ReadonlyArray<string>): ReadonlyArray<string>
} = Function.dual(
  2,
  (local: ReadonlyArray<string>, remote: ReadonlyArray<string>): ReadonlyArray<string> =>
    local.filter((capability) => remote.includes(capability)),
)

export type LifecycleState = "starting" | "ready" | "grace" | "draining" | "stopped"
type LifecycleValue = { state: LifecycleState; clients: number; graceGeneration: number }

export const makeLifecycle = (changed: (state: LifecycleState) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const value = yield* Ref.make<LifecycleValue>({ state: "starting", clients: 0, graceGeneration: 0 })
    const admission = yield* Semaphore.make(1)
    const transition = (update: (current: LifecycleValue) => LifecycleValue) =>
      Ref.modify(value, (current) => {
        const next = update(current)
        return [next.state === current.state ? undefined : next.state, next] as const
      }).pipe(Effect.flatMap((state) => (state === undefined ? Effect.void : changed(state))))
    return {
      state: Ref.get(value).pipe(Effect.map((current) => current.state)),
      ready: Ref.modify(value, (current) => {
        if (current.state !== "starting") return [undefined, current] as const
        const next =
          current.clients === 0
            ? { state: "grace" as const, clients: 0, graceGeneration: current.graceGeneration + 1 }
            : { ...current, state: "ready" as const }
        return [next.state === "grace" ? next.graceGeneration : undefined, next] as const
      }).pipe(Effect.tap((generation) => changed(generation === undefined ? "ready" : "grace"))),
      tryAttach: Ref.modify(
        value,
        (current): readonly [{ readonly attached: boolean; readonly changed: boolean }, LifecycleValue] => {
          if (current.state === "draining" || current.state === "stopped")
            return [{ attached: false, changed: false }, current] as const
          const state = current.state === "grace" ? "ready" : current.state
          return [
            { attached: true, changed: state !== current.state },
            { state, clients: current.clients + 1, graceGeneration: current.graceGeneration + 1 },
          ] as const
        },
      ).pipe(
        Effect.tap((result) => (result.changed === true ? changed("ready") : Effect.void)),
        Effect.map((result) => result.attached),
      ),
      detach: Ref.modify(value, (current) => {
        const clients = Math.max(0, current.clients - 1)
        const entersGrace = clients === 0 && current.state === "ready"
        const next = entersGrace
          ? { state: "grace" as const, clients, graceGeneration: current.graceGeneration + 1 }
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
      runWork: <A, E, R>(fibers: FiberSet.FiberSet<A, E>, work: Effect.Effect<A, E, R>) =>
        admission.withPermits(1)(
          Ref.get(value).pipe(
            Effect.flatMap((current) =>
              current.state === "draining" || current.state === "stopped"
                ? Effect.void.pipe(Effect.as(undefined))
                : FiberSet.run(fibers, work).pipe(Effect.map((fiber) => fiber as typeof fiber | undefined)),
            ),
          ),
        ),
      beginDrain: admission.withPermits(1)(
        transition((current) => (current.state === "stopped" ? current : { ...current, state: "draining" })),
      ),
      stopped: transition((current) => ({ ...current, state: "stopped", clients: 0 })),
    }
  })
