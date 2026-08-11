import { expect, it } from "@effect/vitest"
import { ModelRegistry } from "@batonfx/core"
import { OpenAi } from "@batonfx/providers"
import type * as OpenAiAuth from "@rika/product/openai-auth-service"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { Chat, LanguageModel } from "effect/unstable/ai"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { fromRikaAuth } from "../src/openai-account-credentials"

const credential = (fingerprint: string, generation = `${fingerprint}.generation`) => ({
  accessToken: Redacted.make(`access-${generation}`),
  idToken: Redacted.make(`id-${generation}`),
  refreshToken: Redacted.make(`refresh-${generation}`),
  accountId: Redacted.make(`account-${fingerprint}`),
  fingerprint,
  generation,
  expiresAt: Number.MAX_SAFE_INTEGER,
  refreshedAt: 0,
})

const service = (overrides: Partial<OpenAiAuth.ServiceInterface> = {}): OpenAiAuth.ServiceInterface => ({
  loginBrowser: () => Effect.succeed(credential("expected")),
  loginDevice: Effect.succeed(credential("expected")),
  status: Effect.succeed({ _tag: "Present", fingerprint: "expected" }),
  logout: Effect.succeed({ removed: true, revocationSupported: false }),
  acquire: Effect.succeed(credential("expected")),
  refreshRejected: () => Effect.succeed(credential("expected")),
  ...overrides,
})

it.effect("reads current account credentials per request and forwards rejected generations", () =>
  Effect.gen(function* () {
    let acquisitions = 0
    const rejected: Array<string> = []
    const credentials = fromRikaAuth(
      service({
        acquire: Effect.sync(() => {
          acquisitions = acquisitions + 1
          return credential("expected", `expected.${acquisitions}`)
        }),
        refreshRejected: (generation) => {
          rejected.push(generation)
          return Effect.succeed(credential("expected", "expected.refreshed"))
        },
      }),
      "expected",
    )
    const first = yield* credentials.acquire
    const second = yield* credentials.acquire
    const refreshed = yield* credentials.refreshRejected(second.generation)
    expect(acquisitions).toBe(2)
    expect(Redacted.value(first.accessToken)).toBe("access-expected.1")
    expect(second.accountId).toBe("account-expected")
    expect(rejected).toEqual(["expected.2"])
    expect(refreshed.generation).toBe("expected.refreshed")
  }),
)

it.effect("refuses a different logged-in account before exposing its credentials", () =>
  Effect.gen(function* () {
    const failure = yield* Effect.flip(
      fromRikaAuth(service({ acquire: Effect.succeed(credential("other")) }), "expected").acquire,
    )
    expect(failure).toMatchObject({
      _tag: "@batonfx/providers/OpenAiAccountCredentialError",
      operation: "acquire",
    })
    const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(failure)
    expect(encoded).not.toContain("access-other")
    expect(encoded).not.toContain("account-other")
  }),
)

it.effect("uses the Codex endpoint and refreshes one rejected account request at most once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly headers: Readonly<Record<string, string>> }> = []
      const rejected: Array<string> = []
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push({ url: request.url, headers: request.headers })
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
            ),
          )
        }),
      )
      const provider = OpenAi.layerAccount({
        model: "gpt-5.6-sol",
        config: OpenAi.decodeConfig({ store: false }),
        credentials: fromRikaAuth(
          service({
            acquire: Effect.succeed(credential("expected", "expected.old")),
            refreshRejected: (generation) => {
              rejected.push(generation)
              return Effect.succeed(credential("expected", "expected.new"))
            },
          }),
          "expected",
        ),
      }).pipe(Layer.provide(http))
      const context = yield* Layer.build(provider)
      const model = yield* ModelRegistry.operate(
        { provider: "openai", model: "gpt-5.6-sol" },
        Effect.service(LanguageModel.LanguageModel),
      ).pipe(Effect.provideService(ModelRegistry.ModelRegistry, Context.get(context, ModelRegistry.ModelRegistry)))
      const chat = yield* Chat.fromPrompt([])
      yield* chat
        .generateText({ prompt: "hello" })
        .pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.exit)
      expect(requests).toHaveLength(2)
      expect(requests.map(({ url }) => url)).toEqual([
        "https://chatgpt.com/backend-api/codex/responses",
        "https://chatgpt.com/backend-api/codex/responses",
      ])
      expect(requests.map(({ headers }) => headers.authorization)).toEqual([
        "Bearer access-expected.old",
        "Bearer access-expected.new",
      ])
      expect(requests.every(({ headers }) => headers["chatgpt-account-id"] === "account-expected")).toBe(true)
      expect(rejected).toEqual(["expected.old"])
    }),
  ),
)
