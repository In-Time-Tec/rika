import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { layer, login, logout, status } from "../src/authentication/openrouter-auth-service"
import { ProviderCredentialStore } from "../src/authentication/provider-credential-store"

const memoryStore = (initial: Option.Option<string> = Option.none()) => {
  let value = initial
  return {
    layer: Layer.succeed(ProviderCredentialStore, {
      load: () => Effect.sync(() => value),
      save: (identity, apiKey) =>
        Effect.sync(() => {
          value = Option.some(Redacted.value(apiKey))
        }),
      remove: () =>
        Effect.sync(() => {
          const removed = Option.isSome(value)
          value = Option.none()
          return removed
        }),
    }),
    value: () => value,
  }
}

const httpWith = (statusCode: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new globalThis.Response("{}", { status: statusCode }))),
    ),
  )

const provide =
  <A, E, R>(effect: Effect.Effect<A, E, R>, statusCode = 200) =>
  (store: Layer.Layer<ProviderCredentialStore>) =>
    Effect.scoped(
      Effect.flatMap(Layer.build(layer.pipe(Layer.provide(store), Layer.provide(httpWith(statusCode)))), (context) =>
        Effect.provide(effect, context),
      ),
    )

describe("OpenRouter auth service", () => {
  it.effect("stores a validated API key", () =>
    Effect.gen(function* () {
      const store = memoryStore()
      yield* provide(login(Redacted.make("sk-or-v1-valid")))(store.layer)
      expect(Option.isSome(store.value())).toBe(true)
      expect(store.value().pipe(Option.getOrThrow)).toBe("sk-or-v1-valid")
    }),
  )

  it.effect("rejects an invalid API key and stores nothing", () =>
    Effect.gen(function* () {
      const store = memoryStore()
      const outcome = yield* Effect.exit(provide(login(Redacted.make("sk-or-v1-bad")), 401)(store.layer))
      expect(outcome._tag).toBe("Failure")
      expect(Option.isNone(store.value())).toBe(true)
    }),
  )

  it.effect("reports status from the store and removes on logout", () =>
    Effect.gen(function* () {
      const store = memoryStore(Option.some("sk-or-v1-kept"))
      const statusBefore = yield* provide(status())(store.layer)
      expect(statusBefore).toBe("authenticated")
      const removed = yield* provide(logout())(store.layer)
      expect(removed).toBe(true)
      const statusAfter = yield* provide(status())(store.layer)
      expect(statusAfter).toBe("unauthenticated")
    }),
  )
})
