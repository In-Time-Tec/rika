import { describe, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { Embeddings } from "../src/index"

describe("Embeddings", () => {
  test("fake layer returns deterministic vectors with configured dimensions", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const embeddings = yield* Embeddings.Service
        const vectors = yield* embeddings.embed(["same", "same", "different"])
        return { dimensions: embeddings.dimensions, vectors }
      }).pipe(Effect.provide(Embeddings.fakeLayer({ dimensions: 8 }))),
    )

    expect(result.dimensions).toBe(8)
    expect(result.vectors).toHaveLength(3)
    expect(result.vectors[0]).toBeInstanceOf(Float32Array)
    expect(result.vectors[0]).toHaveLength(8)
    expect(Array.from(result.vectors[0] ?? [])).toEqual(Array.from(result.vectors[1] ?? []))
    expect(Array.from(result.vectors[0] ?? [])).not.toEqual(Array.from(result.vectors[2] ?? []))
  })

  test("live layer constructs without credentials and embed fails typed unavailable", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const embeddings = yield* Embeddings.Service
        return yield* embeddings.embed(["hello"])
      }).pipe(Effect.flip, Effect.provide(Embeddings.layer(Embeddings.optionsFromEnv({})))),
    )

    expect(error).toMatchObject({
      _tag: "EmbeddingsUnavailable",
      key: "RIKA_EMBEDDINGS_API_KEY",
    })
  })

  test("shared model key is only an embeddings fallback when OpenAI is configured", () => {
    expect(Embeddings.optionsFromEnv({ RIKA_API_KEY: "shared" }, { openaiConfigured: false })).toMatchObject({
      apiKey: undefined,
      fallbackApiKeyEnv: undefined,
    })
    const options = Embeddings.optionsFromEnv({ RIKA_API_KEY: "shared" }, { openaiConfigured: true })
    expect(options).toMatchObject({
      fallbackApiKeyEnv: "RIKA_API_KEY",
    })
    expect(options.apiKey === undefined ? undefined : Redacted.value(options.apiKey)).toBe("shared")
  })
})
