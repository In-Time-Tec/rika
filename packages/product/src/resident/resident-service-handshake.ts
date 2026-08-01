import { Function, Schema } from "effect"

declare const RIKA_BUILD_IDENTITY: string | undefined

const protocolVersion = 7
const buildIdentity = typeof RIKA_BUILD_IDENTITY === "string" ? RIKA_BUILD_IDENTITY : "rika-development-build"
const replacementGuard = "active-execution-v1" as const
const ClientKind = Schema.Literals(["interactive", "run", "review", "workflow", "thread-continue", "product"])
const ConnectRole = Schema.Literals(["launch", "reattach"])
type ConnectRole = typeof ConnectRole.Type
const replacementDisposition = (options: {
  readonly connectRole: ConnectRole
  readonly hasActiveExecutionWork: boolean
}) => {
  if (options.connectRole === "reattach") return "restart" as const
  return options.hasActiveExecutionWork ? ("defer" as const) : ("supersede" as const)
}
const WireIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
const Proof = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Handshake = Schema.Struct({
  family: Schema.tag("rika-resident"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  clientKind: ClientKind,
  connectRole: ConnectRole,
  protocolVersion: Schema.Int,
  buildIdentity: WireIdentifier,
  clientProof: Proof,
})
type Handshake = typeof Handshake.Type
const HandshakeAccepted = Schema.Struct({
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
type HandshakeAccepted = typeof HandshakeAccepted.Type
const HandshakeIncompatible = Schema.Struct({
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
type HandshakeIncompatible = typeof HandshakeIncompatible.Type
const HandshakeRejected = Schema.Struct({
  _tag: Schema.tag("rejected"),
  reason: Schema.Literal("draining"),
})
type HandshakeRejected = typeof HandshakeRejected.Type

type ProofHandshake = Pick<
  Handshake,
  "identity" | "clientNonce" | "clientKind" | "connectRole" | "protocolVersion" | "buildIdentity"
>
const proof = (token: string, fields: ReadonlyArray<string | number>) =>
  new Bun.CryptoHasher("sha256", token).update(JSON.stringify(fields)).digest("hex")
const proofMatches = (actual: string, expected: string) => {
  let difference = actual.length ^ expected.length
  for (let index = 0; index < Math.max(actual.length, expected.length); index += 1)
    difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
  return difference === 0
}
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
const clientProof: {
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
const serverProof: {
  (handshake: ProofHandshake, response: ServerProofResponse): (token: string) => string
  (token: string, handshake: ProofHandshake, response: ServerProofResponse): string
} = Function.dual(3, serverProofImpl)
const verifyServerProofImpl = (
  token: string,
  handshake: ProofHandshake,
  response: HandshakeAccepted | HandshakeIncompatible,
) => proofMatches(response.serverProof, serverProof(token, handshake, response))
const verifyServerProof: {
  (handshake: ProofHandshake, response: HandshakeAccepted | HandshakeIncompatible): (token: string) => boolean
  (token: string, handshake: ProofHandshake, response: HandshakeAccepted | HandshakeIncompatible): boolean
} = Function.dual(3, verifyServerProofImpl)
type IncompatibilityIdentity = Pick<HandshakeIncompatible, "protocolVersion" | "buildIdentity">
const isValidIncompatibility: {
  (response: IncompatibilityIdentity): (connectRole: ConnectRole) => boolean
  (connectRole: ConnectRole, response: IncompatibilityIdentity): boolean
} = Function.dual(
  2,
  (connectRole: ConnectRole, response: IncompatibilityIdentity) =>
    response.protocolVersion !== protocolVersion ||
    (connectRole === "launch" && response.buildIdentity !== buildIdentity),
)
type HandshakeResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "AuthenticationFailed" }
  | { readonly _tag: "IdentityMismatch" }
  | { readonly _tag: "ProtocolMismatch" }
  | { readonly _tag: "BuildMismatch" }
const validateHandshake: {
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
const HandshakeV3 = Schema.Struct({
  family: Schema.tag("rika-resident"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  clientKind: ClientKind,
  protocolVersion: Schema.Literal(3),
  buildIdentity: WireIdentifier,
  clientProof: Proof,
})
type HandshakeV3 = typeof HandshakeV3.Type
type ProofHandshakeV3 = Omit<HandshakeV3, "family" | "clientProof">
const clientProofV3: {
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
const validateHandshakeV3: {
  (expected: HandshakeV3Expectation): (handshake: HandshakeV3) => boolean
  (handshake: HandshakeV3, expected: HandshakeV3Expectation): boolean
} = Function.dual(
  2,
  (handshake: HandshakeV3, expected: HandshakeV3Expectation) =>
    handshake.identity === expected.identity &&
    proofMatches(handshake.clientProof, clientProofV3(expected.token, handshake)),
)

export { Handshake, HandshakeAccepted, HandshakeIncompatible, HandshakeRejected, HandshakeV3 }

export const HandshakeProtocol = {
  protocolVersion,
  buildIdentity,
  replacementGuard,
  ClientKind,
  ConnectRole,
  replacementDisposition,
  Handshake,
  HandshakeAccepted,
  HandshakeIncompatible,
  HandshakeRejected,
  HandshakeV3,
  clientProof,
  serverProof,
  verifyServerProof,
  isValidIncompatibility,
  validateHandshake,
  clientProofV3,
  validateHandshakeV3,
} as const
export type { ConnectRole, HandshakeResult }
