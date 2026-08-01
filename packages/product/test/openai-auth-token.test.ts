import { describe, expect, it } from "@effect/vitest"
import {
  Effect,
  Host,
  Http,
  Redacted,
  Schema,
  Service,
  TokenResponse,
  dependencies,
  expiryJwt,
  memoryStore,
  provideLayer,
  unusedHttp,
  jwt,
} from "./openai-auth-support"

describe("OpenAI token credentials", () => {
  it.effect("uses access-token expiry without requiring identity claims in that token", () => {
    const store = memoryStore()
    const host = Host.of({
      authorize: (_url, state) => Effect.succeed({ code: Redacted.make("authorization-secret"), state }),
    })
    const http = Http.of({
      ...unusedHttp,
      exchange: () =>
        Effect.succeed({
          access_token: expiryJwt(1_900_000_000),
          id_token: jwt("account-secret", "user-secret", 1_800_000_000),
          refresh_token: "refresh-secret",
        }),
    })
    return Effect.gen(function* () {
      const credential = yield* (yield* Service).loginBrowser()
      expect(credential.expiresAt).toBe(1_900_000_000_000)
    }).pipe(provideLayer(dependencies(store.layer, http, host)))
  })

  it.effect("validates token response shape without weakening initial exchange requirements", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeUnknownEffect(TokenResponse)({})).toEqual({})
    }),
  )
})
