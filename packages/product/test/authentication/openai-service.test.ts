import { describe, expect, it } from "@effect/vitest"
import { CredentialDisk } from "@rika/product/openai-auth-contract"
import { Effect, Exit, Option, Redacted, Schema } from "effect"
import { AuthError, Host, Http } from "./openai-service.fixture"
import { Service } from "./openai-service.fake"
import { dependencies, memoryStore, provideLayer, unusedHttp } from "./openai-service.harness"
import { tokens } from "./openai-flow.fixture"

describe("OpenAI browser authentication", () => {
  it.effect("persists browser identity while returning redacted secrets and a generated fingerprint", () => {
    const store = memoryStore()
    const host = Host.of({
      authorize: (_url, state) => Effect.succeed({ code: Redacted.make("authorization-secret"), state }),
    })
    const http = Http.of({ ...unusedHttp, exchange: () => Effect.succeed(tokens()) })
    return Effect.gen(function* () {
      const service = yield* Service
      const credential = yield* service.loginBrowser()
      const stored = store.value()
      expect(Option.isSome(stored)).toBe(true)
      if (Option.isNone(stored)) return
      const persisted = yield* Schema.encodeEffect(Schema.fromJsonString(CredentialDisk))(stored.value)
      expect(persisted).toContain(credential.generation)
      expect(persisted).toContain(credential.fingerprint)
      expect(credential.fingerprint).not.toContain("account-secret")
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(credential)
      expect(encoded).not.toContain("refresh-secret")
      expect(encoded).not.toContain("account-secret")
    }).pipe(provideLayer(dependencies(store.layer, http, host)))
  })

  it.effect("blocks a mismatched browser state before token exchange and redacts state/code from errors", () => {
    let exchanges = 0
    const host = Host.of({
      authorize: () =>
        Effect.succeed({ code: Redacted.make("authorization-secret"), state: Redacted.make("callback-secret") }),
    })
    const http = Http.of({
      ...unusedHttp,
      exchange: () =>
        Effect.sync(() => {
          exchanges++
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const exit = yield* Effect.exit(service.loginBrowser())
      expect(Exit.isFailure(exit)).toBe(true)
      expect(exchanges).toBe(0)
      expect(String(exit)).not.toContain("callback-secret")
      expect(String(exit)).not.toContain("authorization-secret")
    }).pipe(provideLayer(dependencies(memoryStore().layer, http, host)))
  })

  it.effect("preserves sanitized host cancellation and timeout errors", () => {
    const store = memoryStore()
    const run = (kind: "cancelled" | "timeout") =>
      Effect.gen(function* () {
        const service = yield* Service
        return yield* Effect.flip(service.loginBrowser())
      }).pipe(
        provideLayer(
          dependencies(
            store.layer,
            unusedHttp,
            Host.of({ authorize: () => Effect.fail(AuthError.make({ kind, message: `safe ${kind}` })) }),
          ),
        ),
      )
    return Effect.gen(function* () {
      expect((yield* run("cancelled")).kind).toBe("cancelled")
      expect((yield* run("timeout")).kind).toBe("timeout")
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(yield* run("cancelled"))).toBe(
        '{"_tag":"OpenAiAuthError","kind":"cancelled","message":"safe cancelled"}',
      )
    })
  })
})
