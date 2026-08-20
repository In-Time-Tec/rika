import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import { importPKCS8, SignJWT } from "jose"

export class AppJwtError extends Schema.TaggedError<AppJwtError>()("GitHubAppJwtError", {
  message: Schema.String,
}) {}

export interface JwtClaims {
  readonly issuer: string
  readonly issuedAt: number
  readonly expiresAt: number
}

export interface JwtCryptoService {
  readonly sign: (
    privateKey: Redacted.Redacted<string>,
    claims: JwtClaims,
  ) => Effect.Effect<Redacted.Redacted<string>, AppJwtError>
}

export class JwtCrypto extends Context.Service<JwtCrypto, JwtCryptoService>()("@rika/github-app/app-jwt/JwtCrypto") {}

const signingFailure = () => AppJwtError.make({ message: "GitHub App JWT signing failed" })

export const joseJwtCryptoLayer = Layer.succeed(
  JwtCrypto,
  JwtCrypto.of({
    sign: Effect.fn("GitHubAppJwt.joseSign")(function* (privateKey, claims) {
      const key = yield* Effect.tryPromise({
        try: () => importPKCS8(Redacted.value(privateKey), "RS256"),
        catch: signingFailure,
      })
      const token = yield* Effect.tryPromise({
        try: () =>
          new SignJWT({})
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer(claims.issuer)
            .setIssuedAt(claims.issuedAt)
            .setExpirationTime(claims.expiresAt)
            .sign(key),
        catch: signingFailure,
      })
      return Redacted.make(token)
    }),
  }),
)

export interface AppJwtService {
  readonly sign: Effect.Effect<Redacted.Redacted<string>, AppJwtError>
}

export class AppJwt extends Context.Service<AppJwt, AppJwtService>()("@rika/github-app/app-jwt/AppJwt") {}

export interface AppJwtOptions {
  readonly issuer: string
  readonly privateKey: Redacted.Redacted<string>
}

export const appJwtLayer = (options: AppJwtOptions) =>
  Layer.effect(
    AppJwt,
    Effect.gen(function* () {
      const crypto = yield* JwtCrypto
      const sign = Effect.fn("GitHubAppJwt.sign")(function* () {
        const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1_000)
        return yield* crypto.sign(options.privateKey, {
          issuer: options.issuer,
          issuedAt: nowSeconds - 60,
          expiresAt: nowSeconds + 600,
        })
      })
      return AppJwt.of({ sign: sign() })
    }),
  )

export const appJwtJoseLayer = (options: AppJwtOptions) => appJwtLayer(options).pipe(Layer.provide(joseJwtCryptoLayer))

export const appJwtTestLayer = (sign: AppJwtService["sign"]) => Layer.succeed(AppJwt, AppJwt.of({ sign }))
