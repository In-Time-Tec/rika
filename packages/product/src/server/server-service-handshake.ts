import { Function, Schema } from "effect"

declare const RIKA_BUILD_IDENTITY: string | undefined

const buildIdentity = typeof RIKA_BUILD_IDENTITY === "string" ? RIKA_BUILD_IDENTITY : "rika-development-build"
const ClientKind = Schema.Literals(["interactive", "run", "thread-continue", "product"])
const ConnectRole = Schema.Literals(["launch", "reattach"])
type ConnectRole = typeof ConnectRole.Type
const WireIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024))
const Proof = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Handshake = Schema.Struct({
  family: Schema.tag("rika-server"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  clientKind: ClientKind,
  connectRole: ConnectRole,
  buildIdentity: WireIdentifier,
  clientProof: Proof,
})
type Handshake = typeof Handshake.Type
const HandshakeAccepted = Schema.Struct({
  _tag: Schema.tag("accepted"),
  family: Schema.tag("rika-server"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  serviceNonce: WireIdentifier,
  connectionId: WireIdentifier,
  buildIdentity: WireIdentifier,
  serverProof: Proof,
  serverPid: Schema.optionalKey(Schema.Int),
})
type HandshakeAccepted = typeof HandshakeAccepted.Type
const HandshakeBuildMismatch = Schema.Struct({
  _tag: Schema.tag("build-mismatch"),
  family: Schema.tag("rika-server"),
  identity: WireIdentifier,
  clientNonce: WireIdentifier,
  serviceNonce: WireIdentifier,
  connectionId: WireIdentifier,
  buildIdentity: WireIdentifier,
  serverProof: Proof,
  serverPid: Schema.optionalKey(Schema.Int),
})
type HandshakeBuildMismatch = typeof HandshakeBuildMismatch.Type
const HandshakeRejected = Schema.Struct({
  _tag: Schema.tag("rejected"),
  reason: Schema.Literal("draining"),
})
type HandshakeRejected = typeof HandshakeRejected.Type

type ProofHandshake = Pick<Handshake, "identity" | "clientNonce" | "clientKind" | "connectRole" | "buildIdentity">
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
    "rika-server-client",
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
      "_tag" | "family" | "identity" | "clientNonce" | "serviceNonce" | "connectionId" | "buildIdentity" | "serverPid"
    >
  | Pick<
      HandshakeBuildMismatch,
      "_tag" | "family" | "identity" | "clientNonce" | "serviceNonce" | "connectionId" | "buildIdentity" | "serverPid"
    >
const serverProofImpl = (token: string, handshake: ProofHandshake, response: ServerProofResponse) =>
  proof(token, [
    "rika-server-response",
    handshake.identity,
    handshake.clientNonce,
    handshake.clientKind,
    handshake.connectRole,
    handshake.buildIdentity,
    response._tag,
    response.serviceNonce,
    response.connectionId,
    response.buildIdentity,
    response.serverPid ?? "absent",
  ])
const serverProof: {
  (handshake: ProofHandshake, response: ServerProofResponse): (token: string) => string
  (token: string, handshake: ProofHandshake, response: ServerProofResponse): string
} = Function.dual(3, serverProofImpl)
const verifyServerProofImpl = (
  token: string,
  handshake: ProofHandshake,
  response: HandshakeAccepted | HandshakeBuildMismatch,
) => proofMatches(response.serverProof, serverProof(token, handshake, response))
const verifyServerProof: {
  (handshake: ProofHandshake, response: HandshakeAccepted | HandshakeBuildMismatch): (token: string) => boolean
  (token: string, handshake: ProofHandshake, response: HandshakeAccepted | HandshakeBuildMismatch): boolean
} = Function.dual(3, verifyServerProofImpl)
type HandshakeResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "AuthenticationFailed" }
  | { readonly _tag: "IdentityMismatch" }
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
    if (handshake.connectRole === "launch" && handshake.buildIdentity !== expected.buildIdentity)
      return { _tag: "BuildMismatch" }
    return { _tag: "Accepted" }
  },
)
export { Handshake, HandshakeAccepted, HandshakeBuildMismatch, HandshakeRejected }

export const HandshakeProtocol = {
  buildIdentity,
  ClientKind,
  ConnectRole,
  Handshake,
  HandshakeAccepted,
  HandshakeBuildMismatch,
  HandshakeRejected,
  clientProof,
  serverProof,
  verifyServerProof,
  validateHandshake,
} as const
export type { ConnectRole, HandshakeResult }
