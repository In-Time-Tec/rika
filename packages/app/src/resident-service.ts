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
import { Input, InteractiveCommand, InteractiveEventSchema, OperationUnavailable } from "./operation-contract"
import type { InteractiveSession, Interface as OperationInterface } from "./operation-contract"

export type InteractiveInput = Extract<Input, { readonly _tag: "Interactive" }>

declare const RIKA_BUILD_IDENTITY: string | undefined

export const protocolVersion = 5
export const buildIdentity = typeof RIKA_BUILD_IDENTITY === "string" ? RIKA_BUILD_IDENTITY : "rika-development-build"
export const replacementGuard = "active-execution-v1" as const
export const ClientKind = Schema.Literals(["interactive", "run", "review", "workflow", "thread-continue", "product"])
export const ConnectRole = Schema.Literals(["launch", "reattach"])
export type ConnectRole = typeof ConnectRole.Type
export const replacementDisposition = (options: {
  readonly connectRole: ConnectRole
  readonly hasActiveExecutionWork: boolean
}) => {
  if (options.connectRole === "reattach") return "restart" as const
  return options.hasActiveExecutionWork ? ("defer" as const) : ("supersede" as const)
}
const WireIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
const Proof = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const Handshake = Schema.Struct({
  family: Schema.tag("rika-resident"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  clientKind: ClientKind,
  connectRole: ConnectRole,
  protocolVersion: Schema.Int,
  buildIdentity: WireIdentifier,
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
  buildIdentity: WireIdentifier,
  serverProof: Proof,
  residentPid: Schema.optionalKey(Schema.Int),
})
export type HandshakeAccepted = typeof HandshakeAccepted.Type

export const HandshakeIncompatible = Schema.Struct({
  _tag: Schema.tag("incompatible"),
  disposition: Schema.Literals(["supersede", "restart", "defer"]),
  replacementGuard: Schema.Literal(replacementGuard),
  family: Schema.tag("rika-resident"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  serviceNonce: WireIdentifier,
  connectionId: WireIdentifier,
  protocolVersion: Schema.Int,
  buildIdentity: WireIdentifier,
  serverProof: Proof,
  residentPid: Schema.optionalKey(Schema.Int),
})
export type HandshakeIncompatible = typeof HandshakeIncompatible.Type

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
  HandshakeIncompatible,
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

export const runtimeRestartExitCode = 75

export class ResidentRestartRequired extends Schema.TaggedErrorClass<ResidentRestartRequired>()(
  "ResidentRestartRequired",
  {
    message: Schema.String,
    threadId: Schema.optionalKey(Schema.String),
  },
) {
  override readonly [Runtime.errorExitCode] = runtimeRestartExitCode
  override readonly [Runtime.errorReported] = false
}

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
  ) => Effect.Effect<void, OperationUnavailable | ResidentServiceError | ResidentRestartRequired>
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

type ProofHandshake = Pick<
  Handshake,
  "identity" | "clientNonce" | "clientKind" | "connectRole" | "protocolVersion" | "buildIdentity"
>

const clientProofImpl = (token: string, handshake: ProofHandshake) =>
  proof(token, [
    "rika-resident-client",
    handshake.protocolVersion,
    handshake.identity,
    handshake.clientNonce,
    handshake.clientKind,
    handshake.connectRole,
    handshake.buildIdentity,
  ])
export const clientProof: {
  (handshake: ProofHandshake): (token: string) => string
  (token: string, handshake: ProofHandshake): string
} = Function.dual(2, clientProofImpl)

type ServerProofResponse =
  | Pick<
      HandshakeAccepted,
      | "_tag"
      | "family"
      | "identity"
      | "clientNonce"
      | "serviceNonce"
      | "connectionId"
      | "protocolVersion"
      | "buildIdentity"
      | "residentPid"
    >
  | Pick<
      HandshakeIncompatible,
      | "_tag"
      | "disposition"
      | "replacementGuard"
      | "family"
      | "identity"
      | "clientNonce"
      | "serviceNonce"
      | "connectionId"
      | "protocolVersion"
      | "buildIdentity"
      | "residentPid"
    >

const serverProofImpl = (token: string, handshake: ProofHandshake, response: ServerProofResponse) =>
  proof(token, [
    "rika-resident-server",
    handshake.protocolVersion,
    handshake.identity,
    handshake.clientNonce,
    handshake.clientKind,
    handshake.connectRole,
    handshake.buildIdentity,
    response._tag,
    response._tag === "incompatible" ? response.disposition : "accepted",
    response._tag === "incompatible" ? response.replacementGuard : "absent",
    response.serviceNonce,
    response.connectionId,
    response.protocolVersion,
    response.buildIdentity,
    response.residentPid ?? "absent",
  ])
export const serverProof: {
  (handshake: ProofHandshake, response: ServerProofResponse): (token: string) => string
  (token: string, handshake: ProofHandshake, response: ServerProofResponse): string
} = Function.dual(3, serverProofImpl)

const verifyServerProofImpl = (
  token: string,
  handshake: ProofHandshake,
  response: HandshakeAccepted | HandshakeIncompatible,
) => proofMatches(response.serverProof, serverProof(token, handshake, response))
export const verifyServerProof: {
  (handshake: ProofHandshake, response: HandshakeAccepted | HandshakeIncompatible): (token: string) => boolean
  (token: string, handshake: ProofHandshake, response: HandshakeAccepted | HandshakeIncompatible): boolean
} = Function.dual(3, verifyServerProofImpl)

type IncompatibilityIdentity = Pick<HandshakeIncompatible, "protocolVersion" | "buildIdentity">
export const isValidIncompatibility: {
  (response: IncompatibilityIdentity): (connectRole: ConnectRole) => boolean
  (connectRole: ConnectRole, response: IncompatibilityIdentity): boolean
} = Function.dual(
  2,
  (connectRole: ConnectRole, response: IncompatibilityIdentity) =>
    response.protocolVersion !== protocolVersion ||
    (connectRole === "launch" && response.buildIdentity !== buildIdentity),
)

export type HandshakeResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "AuthenticationFailed" }
  | { readonly _tag: "IdentityMismatch" }
  | { readonly _tag: "ProtocolMismatch" }
  | { readonly _tag: "BuildMismatch" }

export const validateHandshake: {
  (expected: {
    readonly identity: string
    readonly token: string
    readonly buildIdentity: string
  }): (handshake: Handshake) => HandshakeResult
  (
    handshake: Handshake,
    expected: { readonly identity: string; readonly token: string; readonly buildIdentity: string },
  ): HandshakeResult
} = Function.dual(
  2,
  (
    handshake: Handshake,
    expected: { readonly identity: string; readonly token: string; readonly buildIdentity: string },
  ): HandshakeResult => {
    if (handshake.identity !== expected.identity) return { _tag: "IdentityMismatch" }
    if (!proofMatches(handshake.clientProof, clientProof(expected.token, handshake)))
      return { _tag: "AuthenticationFailed" }
    if (handshake.protocolVersion !== protocolVersion) return { _tag: "ProtocolMismatch" }
    if (handshake.connectRole === "launch" && handshake.buildIdentity !== expected.buildIdentity)
      return { _tag: "BuildMismatch" }
    return { _tag: "Accepted" }
  },
)

export const HandshakeV3 = Schema.Struct({
  family: Schema.tag("rika-resident"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  clientKind: ClientKind,
  protocolVersion: Schema.Literal(3),
  buildIdentity: WireIdentifier,
  clientProof: Proof,
})
export type HandshakeV3 = typeof HandshakeV3.Type
type ProofHandshakeV3 = Omit<HandshakeV3, "family" | "clientProof">
export const clientProofV3: {
  (handshake: ProofHandshakeV3): (token: string) => string
  (token: string, handshake: ProofHandshakeV3): string
} = Function.dual(2, (token: string, handshake: ProofHandshakeV3) =>
  proof(token, [
    "rika-resident-client",
    handshake.protocolVersion,
    handshake.identity,
    handshake.clientNonce,
    handshake.clientKind,
    handshake.buildIdentity,
  ]),
)
type HandshakeV3Expectation = { readonly identity: string; readonly token: string }
export const validateHandshakeV3: {
  (expected: HandshakeV3Expectation): (handshake: HandshakeV3) => boolean
  (handshake: HandshakeV3, expected: HandshakeV3Expectation): boolean
} = Function.dual(
  2,
  (handshake: HandshakeV3, expected: HandshakeV3Expectation) =>
    handshake.identity === expected.identity &&
    proofMatches(handshake.clientProof, clientProofV3(expected.token, handshake)),
)

export type LifecycleState = "starting" | "ready" | "grace" | "draining" | "stopped"
type LifecycleValue = { state: LifecycleState; clients: number; graceGeneration: number; replacementWork: number }

export const makeLifecycle = (changed: (state: LifecycleState) => Effect.Effect<void>) =>
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
