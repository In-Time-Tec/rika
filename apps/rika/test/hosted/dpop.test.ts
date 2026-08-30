import { Buffer } from "node:buffer"
import { Effect, Redacted, Schema } from "effect"
import { expect, it } from "@effect/vitest"
import { generate, proof, publicJwk, thumbprint } from "../../src/hosted/dpop"

const decoded = (value: string) =>
  Schema.decodeSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    Buffer.from(value, "base64url").toString("utf8"),
  )

const decodedClaims = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ htm: Schema.String, htu: Schema.String, ath: Schema.String, jti: Schema.String }),
  ),
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
    const claims = decodedClaims(Buffer.from(payload!, "base64url").toString("utf8"))
    expect(claims.htm).toBe("POST")
    expect(claims.htu).toBe("https://hosted.example.test/api/v1/connections")
    expect(claims.ath.length).toBeGreaterThan(0)
    expect(claims.jti).toBe("proof-id")
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64)
  }),
)
