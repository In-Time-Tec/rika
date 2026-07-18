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
import { Input, InteractiveCommand, InteractiveEventSchema, OperationUnavailable } from "./operation-contract"
import type { InteractiveSession, Interface as OperationInterface } from "./operation-contract"

export type InteractiveInput = Extract<Input, { readonly _tag: "Interactive" }>

export const protocolVersion = 1
export const ClientKind = Schema.Literals(["interactive", "run", "review", "workflow", "thread-continue", "product"])
const WireIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
const Proof = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Handshake = Schema.Struct({
  family: Schema.tag("rika-resident"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  clientKind: ClientKind,
  protocolVersion: Schema.Int,
  clientProof: Proof,
})
export type Handshake = typeof Handshake.Type

export const HandshakeAccepted = Schema.Struct({
  _tag: Schema.tag("accepted"),
  family: Schema.tag("rika-resident"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  serviceNonce: WireIdentifier,
  connectionId: WireIdentifier,
  protocolVersion: Schema.Int,
  serverProof: Proof,
  residentPid: Schema.optionalKey(Schema.Int),
})
export type HandshakeAccepted = typeof HandshakeAccepted.Type

export const HandshakeRejected = Schema.Struct({
  _tag: Schema.tag("rejected"),
  reason: Schema.Literal("draining"),
})
export type HandshakeRejected = typeof HandshakeRejected.Type

export const Ping = Schema.Struct({ _tag: Schema.tag("ping"), id: Schema.String })
export const Pong = Schema.Struct({ _tag: Schema.tag("pong"), id: Schema.String })
export const OperationRequest = Schema.Struct({
  _tag: Schema.tag("operation"),
  requestId: Schema.String,
  input: Input,
})
const PositiveSequence = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const InteractiveCommandRequest = Schema.Struct({
  _tag: Schema.tag("interactive-command"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
  command: InteractiveCommand,
})
export const CancelInteractiveCommand = Schema.Struct({
  _tag: Schema.tag("cancel-interactive-command"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
})
export const InteractiveFeedAck = Schema.Struct({
  _tag: Schema.tag("interactive-feed-ack"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  throughSequence: PositiveSequence,
})
export const InteractiveFeedReplay = Schema.Struct({
  _tag: Schema.tag("interactive-feed-replay"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  afterSequence: NonNegativeSequence,
})
export const InteractiveEnd = Schema.Struct({
  _tag: Schema.tag("interactive-end"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
})
export const CancelRequest = Schema.Struct({ _tag: Schema.tag("cancel"), requestId: Schema.String })
export const ClientMessage = Schema.Union([
  Handshake,
  Ping,
  OperationRequest,
  InteractiveCommandRequest,
  CancelInteractiveCommand,
  InteractiveFeedAck,
  InteractiveFeedReplay,
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
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  feedCapacity: PositiveSequence,
})
export const InteractiveFeedEvent = Schema.Struct({
  _tag: Schema.tag("interactive-feed-event"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  sequence: PositiveSequence,
  event: InteractiveEventSchema,
})
export const InteractiveFeedResync = Schema.Struct({
  _tag: Schema.tag("interactive-feed-resync"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  sequence: PositiveSequence,
  events: Schema.Array(InteractiveEventSchema),
})
export const InteractiveCommandCompleted = Schema.Struct({
  _tag: Schema.tag("interactive-command-completed"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
})
export const InteractiveCommandFailed = Schema.Struct({
  _tag: Schema.tag("interactive-command-failed"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
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
  Pong,
  Output,
  InteractiveStarted,
  InteractiveFeedEvent,
  InteractiveFeedResync,
  InteractiveCommandCompleted,
  InteractiveCommandFailed,
  OperationCompleted,
  OperationFailed,
])
export type ClientMessage = typeof ClientMessage.Type
export type ServerMessage = typeof ServerMessage.Type

export class ResidentServiceError extends Schema.TaggedErrorClass<ResidentServiceError>()("ResidentServiceError", {
  reason: Schema.Literals([
    "authentication-failed",
    "identity-mismatch",
    "incompatible-resident",
    "foreign-listener",
    "resident-absent",
    "resident-draining",
    "startup-failed",
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

export interface StartedHost {
  readonly pid: number
  readonly startup: Effect.Effect<void, ResidentServiceError>
  readonly detach: Effect.Effect<void, ResidentServiceError>
  readonly abort: Effect.Effect<void>
}

export type Owner = (
  interactive: (input: InteractiveInput, session: InteractiveSession) => Effect.Effect<void, OperationUnavailable>,
) => Effect.Effect<OperationInterface, ResidentServiceError, Scope.Scope>

export interface Interface {
  readonly getOrCreate: (options: {
    readonly profile: string
    readonly dataRoot: string
    readonly clientKind: Handshake["clientKind"]
    readonly graceMilliseconds?: number
    readonly startHost?: () => Effect.Effect<
      StartedHost,
      ResidentServiceError,
      ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
    >
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

const proof = (token: string, fields: ReadonlyArray<string | number>) =>
  new Bun.CryptoHasher("sha256", token).update(JSON.stringify(fields)).digest("hex")

const proofMatches = (actual: string, expected: string) => {
  let difference = actual.length ^ expected.length
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1)
    difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
  return difference === 0
}

type ProofHandshake = Pick<Handshake, "identity" | "clientNonce" | "clientKind" | "protocolVersion">

const clientProofImpl = (token: string, handshake: ProofHandshake) =>
  proof(token, [
    "rika-resident-client",
    handshake.protocolVersion,
    handshake.identity,
    handshake.clientNonce,
    handshake.clientKind,
  ])
export const clientProof: {
  (handshake: ProofHandshake): (token: string) => string
  (token: string, handshake: ProofHandshake): string
} = Function.dual(2, clientProofImpl)

const serverProofImpl = (
  token: string,
  handshake: ProofHandshake,
  accepted: Pick<HandshakeAccepted, "serviceNonce" | "connectionId">,
) =>
  proof(token, [
    "rika-resident-server",
    handshake.protocolVersion,
    handshake.identity,
    handshake.clientNonce,
    handshake.clientKind,
    accepted.serviceNonce,
    accepted.connectionId,
  ])
export const serverProof: {
  (
    handshake: ProofHandshake,
    accepted: Pick<HandshakeAccepted, "serviceNonce" | "connectionId">,
  ): (token: string) => string
  (token: string, handshake: ProofHandshake, accepted: Pick<HandshakeAccepted, "serviceNonce" | "connectionId">): string
} = Function.dual(3, serverProofImpl)

const verifyServerProofImpl = (token: string, handshake: ProofHandshake, accepted: HandshakeAccepted) =>
  proofMatches(accepted.serverProof, serverProof(token, handshake, accepted))
export const verifyServerProof: {
  (handshake: ProofHandshake, accepted: HandshakeAccepted): (token: string) => boolean
  (token: string, handshake: ProofHandshake, accepted: HandshakeAccepted): boolean
} = Function.dual(3, verifyServerProofImpl)

export type HandshakeResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "AuthenticationFailed" }
  | { readonly _tag: "IdentityMismatch" }
  | { readonly _tag: "ProtocolMismatch" }

export const validateHandshake: {
  (expected: { readonly identity: string; readonly token: string }): (handshake: Handshake) => HandshakeResult
  (handshake: Handshake, expected: { readonly identity: string; readonly token: string }): HandshakeResult
} = Function.dual(
  2,
  (handshake: Handshake, expected: { readonly identity: string; readonly token: string }): HandshakeResult => {
    if (handshake.identity !== expected.identity) return { _tag: "IdentityMismatch" }
    if (handshake.protocolVersion !== protocolVersion) return { _tag: "ProtocolMismatch" }
    if (!proofMatches(handshake.clientProof, clientProof(expected.token, handshake)))
      return { _tag: "AuthenticationFailed" }
    return { _tag: "Accepted" }
  },
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
