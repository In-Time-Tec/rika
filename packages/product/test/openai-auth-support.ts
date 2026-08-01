import {
  Cause,
  Context,
  Crypto,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Function,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
} from "effect"
import { TestClock } from "effect/testing"
import { createHash } from "node:crypto"
import * as AuthFlow from "../src/authentication/openai-auth-flow"
import { Host, Http, Presenter, Store } from "../src/authentication/openai-auth-flow"
import * as Contract from "../src/authentication/openai-auth-contract"
import { Service, layer } from "../src/authentication/openai-auth-service"

export {
  Cause,
  Context,
  Crypto,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Function,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
  TestClock,
}
export const Flow = AuthFlow
export const AuthError = AuthFlow.Errors.AuthError
export const Errors = AuthFlow.Errors
export { Contract, Host, Http, Presenter, Store, Service, layer }
export const TokenResponse = Contract.TokenResponse

export const digest = (_algorithm: string, data: Uint8Array) =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", data).then((value) => new Uint8Array(value)))

export const deterministicCrypto = (start = 0) => {
  let next = start
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => next++ & 255),
      digest,
    }),
  )
}

export const jwt = (account = "account-secret", user = "user-secret", exp = 2_000_000_000) => {
  const payload = Encoding.encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp,
        "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: user },
      }),
    ),
  )
  return `header.${payload}.signature`
}

export const expiryJwt = (exp: number) => {
  const payload = Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify({ exp })))
  return `header.${payload}.signature`
}

export const tokens = (account?: string, user?: string) => ({
  access_token: jwt(account, user),
  id_token: jwt(account, user),
  refresh_token: "refresh-secret",
  expires_in: 3600,
})

type Disk = typeof Contract.CredentialDisk.Type
export const disk = (overrides: Partial<Disk> = {}): Disk => ({
  formatVersion: Flow.configuration.credentialFormatVersion,
  accessToken: jwt(),
  idToken: jwt(),
  refreshToken: "refresh-secret",
  accountId: "account-secret",
  fingerprint: createHash("sha256").update("account-secret\0user-secret").digest("base64url"),
  generation: "generation-1",
  expiresAt: 2_000_000_000_000,
  refreshedAt: 1,
  ...overrides,
})

export const memoryStore = (initial: Option.Option<Disk> = Option.none()) => {
  let value = initial
  let serialized = 0
  return {
    layer: Layer.effect(
      Store,
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        return Store.of({
          load: Effect.sync(() => value),
          save: (next) =>
            Effect.sync(() => {
              value = Option.some(next)
            }),
          remove: Effect.sync(() => {
            const removed = Option.isSome(value)
            value = Option.none()
            return removed
          }),
          serialized: (effect) =>
            semaphore.withPermits(1)(
              Effect.sync(() => {
                serialized++
              }).pipe(Effect.andThen(effect)),
            ),
        })
      }),
    ),
    value: () => value,
    serialized: () => serialized,
  }
}

export const dependencies = (
  store: Layer.Layer<Store>,
  http: Http["Service"],
  host?: Host["Service"],
  presenter?: Presenter["Service"],
) =>
  layer({ deviceTimeout: 5_000 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        store,
        deterministicCrypto(),
        Layer.succeed(Http, http),
        Layer.succeed(Host, host ?? Host.of({ authorize: () => Effect.die("unused") })),
        Layer.succeed(Presenter, presenter ?? Presenter.of({ device: () => Effect.void })),
      ),
    ),
  )

export const provideLayer: {
  <AOut, EOut, RIn>(
    provided: Layer.Layer<AOut, EOut, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | EOut, RIn | Exclude<R, AOut>>
  <A, E, R, AOut, EOut, RIn>(
    effect: Effect.Effect<A, E, R>,
    provided: Layer.Layer<AOut, EOut, RIn>,
  ): Effect.Effect<A, E | EOut, RIn | Exclude<R, AOut>>
} = Function.dual(
  2,
  <A, E, R, AOut, EOut, RIn>(effect: Effect.Effect<A, E, R>, provided: Layer.Layer<AOut, EOut, RIn>) =>
    Effect.scoped(
      Layer.build(provided).pipe(
        Effect.flatMap((context) => effect.pipe(Effect.provide(context as unknown as Context.Context<R>))),
      ),
    ),
)

export const unusedHttp = Http.of({
  exchange: () => Effect.die("unused"),
  refresh: () => Effect.die("unused"),
  deviceStart: Effect.die("unused"),
  devicePoll: () => Effect.die("unused"),
})
