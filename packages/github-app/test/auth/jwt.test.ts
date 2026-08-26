import * as AppJwt from "../../src/auth/jwt"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { provide } from "../support/layer"

describe("GitHub App JWT", () => {
  it.effect("signs bounded GitHub App claims through the crypto boundary", () => {
    const claims: Array<AppJwt.JwtClaims> = []
    const privateKeys: Array<Redacted.Redacted<string>> = []
    const cryptoLayer = Layer.succeed(
      AppJwt.JwtCrypto,
      AppJwt.JwtCrypto.of({
        sign: (privateKey, input) => {
          privateKeys.push(privateKey)
          claims.push(input)
          return Effect.succeed(Redacted.make("signed-app-jwt"))
        },
      }),
    )
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_700_000_000_000)
      const signer = yield* AppJwt.AppJwt
      expect(Redacted.value(yield* signer.sign)).toBe("signed-app-jwt")
      expect(claims).toEqual([
        {
          issuer: "Iv1.client-id",
          issuedAt: 1_699_999_940,
          expiresAt: 1_700_000_600,
        },
      ])
      expect(Redacted.value(privateKeys[0]!)).toBe("private-key")
    }).pipe(
      provide(
        AppJwt.appJwtLayer({ issuer: "Iv1.client-id", privateKey: Redacted.make("private-key") }).pipe(
          Layer.provide(cryptoLayer),
        ),
      ),
    )
  })

  it.effect("maps jose failures without exposing private key material", () =>
    Effect.gen(function* () {
      const signer = yield* AppJwt.AppJwt
      const error = yield* Effect.flip(signer.sign)
      expect(error.message).toBe("GitHub App JWT signing failed")
      expect(String(error)).not.toContain("not-a-private-key")
    }).pipe(
      provide(AppJwt.appJwtJoseLayer({ issuer: "Iv1.client-id", privateKey: Redacted.make("not-a-private-key") })),
    ),
  )
})
