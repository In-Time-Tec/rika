import { Buffer } from "node:buffer"
import { Clock, Effect, Redacted, Schema } from "effect"
import { HostedError, PrivateJwk, type PublicJwk } from "./contract"

const failure = (message: string) => HostedError.make({ kind: "host", message })
const encoded = (value: string | Uint8Array) =>
  Buffer.from(value).toString("base64url")
const Header = Schema.Struct({ typ: Schema.Literal("dpop+jwt"), alg: Schema.Literal("ES256"), jwk: Schema.Unknown })
const Payload = Schema.Struct({
  htu: Schema.String,
  htm: Schema.String,
  iat: Schema.Int,
  jti: Schema.String,
  ath: Schema.optionalKey(Schema.String),
})
const Thumbprint = Schema.Struct({
  crv: Schema.Literal("P-256"),
  kty: Schema.Literal("EC"),
  x: Schema.String,
  y: Schema.String,
})
const encodeHeader = Schema.encodeSync(Schema.fromJsonString(Header))
const encodePayload = Schema.encodeSync(Schema.fromJsonString(Payload))
const encodeThumbprint = Schema.encodeSync(Schema.fromJsonString(Thumbprint))

export const publicJwk = (key: PrivateJwk): PublicJwk => ({
  kty: "EC",
  crv: "P-256",
  x: key.x,
  y: key.y,
})

export const generate = Effect.fn("HostedDpop.generate")(function* () {
  const pair = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
    catch: () => failure("Could not generate the installation DPoP key"),
  })
  const exported = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.exportKey("jwk", pair.privateKey),
    catch: () => failure("Could not export the installation DPoP key"),
  })
  return yield* Schema.decodeUnknownEffect(PrivateJwk)(exported).pipe(
    Effect.mapError(() => failure("The generated installation DPoP key was invalid")),
  )
})

export const thumbprint = Effect.fn("HostedDpop.thumbprint")(function* (key: PublicJwk) {
  const canonical = encodeThumbprint({ crv: key.crv, kty: key.kty, x: key.x, y: key.y })
  const digest = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)),
    catch: () => failure("Could not identify the installation DPoP key"),
  })
  return encoded(new Uint8Array(digest))
})

export const proof = Effect.fn("HostedDpop.proof")(function* (input: {
  readonly method: string
  readonly url: string
  readonly privateJwk: PrivateJwk
  readonly jti: string
  readonly accessToken?: Redacted.Redacted<string> | undefined
}) {
  const now = yield* Clock.currentTimeMillis
  const header = encoded(encodeHeader({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk(input.privateJwk) }))
  const accessToken = input.accessToken
  const accessHash =
    accessToken === undefined
      ? undefined
      : yield* Effect.tryPromise({
          try: () => globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(Redacted.value(accessToken))),
          catch: () => failure("Could not bind the DPoP proof to its access token"),
        })
  const ath = accessHash === undefined ? undefined : encoded(new Uint8Array(accessHash))
  const claims = { htu: input.url, htm: input.method.toUpperCase(), iat: Math.floor(now / 1000), jti: input.jti }
  if (ath !== undefined) Object.assign(claims, { ath })
  const payload = encoded(
    encodePayload(claims),
  )
  const signingInput = `${header}.${payload}`
  const key = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.importKey("jwk", input.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
      ]),
    catch: () => failure("Could not import the installation DPoP key"),
  })
  const signature = yield* Effect.tryPromise({
    try: () =>
      globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)),
    catch: () => failure("Could not create a DPoP proof"),
  })
  return `${signingInput}.${encoded(new Uint8Array(signature))}`
})
