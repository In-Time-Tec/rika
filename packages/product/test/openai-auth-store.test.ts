import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, Schema } from "effect"
import { Http, Store } from "./openai-auth-test-contract"
import { Service } from "./openai-auth-test-service"
import { dependencies, memoryStore, provideLayer, unusedHttp } from "./openai-auth-test-layers"
import { disk, tokens } from "./openai-auth-test-credentials"
import * as Contract from "../src/authentication/openai-auth-contract"
import { createHash } from "node:crypto"

describe("OpenAI credential state", () => {
  it.effect("reports every status and does not mislabel unsafe storage as corrupt", () => {
    const status = (load: Store["Service"]["load"]) =>
      Effect.gen(function* () {
        return yield* (yield* Service).status
      }).pipe(
        provideLayer(
          dependencies(
            Layer.succeed(
              Store,
              Store.of({ load, save: () => Effect.void, remove: Effect.succeed(false), serialized: (e) => e }),
            ),
            unusedHttp,
          ),
        ),
      )
    return Effect.gen(function* () {
      expect((yield* status(Effect.succeed(Option.none())))._tag).toBe("Unauthenticated")
      expect((yield* status(Effect.succeed(Option.some(disk({ expiresAt: 0 })))))._tag).toBe("RefreshRequired")
      expect((yield* status(Effect.succeed(Option.some(disk({ expiresAt: Number.MAX_SAFE_INTEGER })))))._tag).toBe(
        "Present",
      )
      expect((yield* status(Effect.fail(Contract.StoreError.make({ kind: "corrupt", message: "safe" }))))._tag).toBe(
        "Corrupt",
      )
      expect(
        (yield* Effect.flip(status(Effect.fail(Contract.StoreError.make({ kind: "unsafe", message: "safe" }))))).kind,
      ).toBe("unsafe")
    })
  })

  it.effect("serializes logout and returns an explicitly local-only result", () => {
    const store = memoryStore(Option.some(disk()))
    return Effect.gen(function* () {
      const result = yield* (yield* Service).logout
      expect(result).toEqual({ removed: true, revocationSupported: false })
      expect(store.serialized()).toBe(1)
    }).pipe(provideLayer(dependencies(store.layer, unusedHttp)))
  })

  it.effect("coalesces same-generation refreshes and returns current credentials for stale generations", () => {
    const store = memoryStore(Option.some(disk()))
    let refreshes = 0
    const http = Http.of({
      ...unusedHttp,
      refresh: () =>
        Effect.sync(() => {
          refreshes++
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const values = yield* Effect.all(
        [
          service.refreshRejected("generation-1"),
          service.refreshRejected("generation-1"),
          service.refreshRejected("generation-1"),
        ],
        { concurrency: "unbounded" },
      )
      expect(refreshes).toBe(1)
      expect(new Set(values.map((value) => value.generation)).size).toBe(1)
      const current = yield* service.refreshRejected("stale-generation")
      expect(current.generation).toBe(values[0]!.generation)
      expect(refreshes).toBe(1)
    }).pipe(provideLayer(dependencies(store.layer, http)))
  })

  it.effect("rejects a refreshed different nested identity without overwriting credentials", () => {
    const original = disk()
    const store = memoryStore(Option.some(original))
    const http = Http.of({ ...unusedHttp, refresh: () => Effect.succeed(tokens("other-account", "other-user")) })
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Service).refreshRejected(original.generation))
      expect(error.kind).toBe("account-mismatch")
      expect(Option.getOrThrow(store.value())).toEqual(original)
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(error)).not.toContain("other-account")
    }).pipe(provideLayer(dependencies(store.layer, http)))
  })

  it.effect("rejects a stale rejected generation after the stored account changes", () => {
    const firstBase = disk()
    const first = { ...firstBase, generation: `${firstBase.fingerprint}.first` }
    const secondBase = disk({
      accountId: "other-account",
      fingerprint: createHash("sha256").update("other-account\\0other-user").digest("base64url"),
    })
    const second = { ...secondBase, generation: `${secondBase.fingerprint}.second` }
    const store = memoryStore(Option.some(second))
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Service).refreshRejected(first.generation))
      expect(error.kind).toBe("account-mismatch")
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(error)).not.toContain("other-account")
    }).pipe(provideLayer(dependencies(store.layer, unusedHttp)))
  })
})
