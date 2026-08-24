import { Buffer } from "node:buffer"
import { Effect, Redacted, Schema } from "effect"
import { expect, it } from "@effect/vitest"
import { generate, proof, publicJwk, thumbprint } from "../../src/hosted/dpop"

const decoded = (value: string) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    Buffer.from(value, "base64url").toString("utf8"),
  )

it.effect("generates P-256 keys, RFC thumbprints, and access-bound DPoP proofs", () =>
  Effect.gen(function* () {
    const privateJwk = yield* generate()
    const publicKey = publicJwk(privateJwk)
    const firstThumbprint = yield* thumbprint(publicKey)
    const secondThumbprint = yield* thumbprint(publicKey)
    expect(firstThumbprint).toBe(secondThumbprint)
    const value = yield* proof({
      method: "post",
      url: "https://hosted.example.test/api/v1/connections",
      privateJwk,
      jti: "proof-id",
      accessToken: Redacted.make("opaque-access"),
    })
    const [header, payload, signature] = value.split(".")
    expect(decoded(header!)).toMatchObject({ typ: "dpop+jwt", alg: "ES256", jwk: publicKey })
    expect(decoded(payload!)).toMatchObject({
      htm: "POST",
      htu: "https://hosted.example.test/api/v1/connections",
      ath: expect.any(String),
      jti: expect.any(String),
    })
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64)
  }),
)
