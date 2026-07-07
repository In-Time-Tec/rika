import { OpenAiClient, OpenAiEmbeddingModel } from "@effect/ai-openai"
import { Effect, Context, Layer, Redacted, Schema } from "effect"
import { EmbeddingModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import * as OpenAi from "./openai"

export interface Options {
  readonly apiKey?: Redacted.Redacted | undefined
  readonly apiKeyEnv?: string | undefined
  readonly fallbackApiKeyEnv?: string | undefined
  readonly apiUrl?: string | undefined
  readonly model?: OpenAiEmbeddingModel.Model | undefined
  readonly dimensions?: number | undefined
  readonly batchSize?: number | undefined
}

export interface EnvOptions {
  readonly openaiConfigured?: boolean
}

export type Availability =
  | { readonly available: true; readonly model: string; readonly dimensions: number }
  | { readonly available: false; readonly reason: string }

export class EmbeddingsUnavailable extends Schema.TaggedErrorClass<EmbeddingsUnavailable>()("EmbeddingsUnavailable", {
  message: Schema.String,
  key: Schema.String,
}) {}

export class EmbeddingsProviderError extends Schema.TaggedErrorClass<EmbeddingsProviderError>()(
  "EmbeddingsProviderError",
  {
    message: Schema.String,
    provider: Schema.String,
    model: Schema.String,
  },
) {}

export class EmbeddingsValidationError extends Schema.TaggedErrorClass<EmbeddingsValidationError>()(
  "EmbeddingsValidationError",
  {
    message: Schema.String,
    model: Schema.String,
    dimensions: Schema.Int,
  },
) {}

export type EmbeddingsError = EmbeddingsUnavailable | EmbeddingsProviderError | EmbeddingsValidationError

export interface Interface {
  readonly dimensions: number
  readonly availability: Effect.Effect<Availability>
  readonly embed: (texts: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Float32Array>, EmbeddingsError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/llm/Embeddings") {}

export const defaultModel = "text-embedding-3-small" satisfies OpenAiEmbeddingModel.Model
export const defaultDimensions = 1536
export const defaultApiKeyEnv = "RIKA_EMBEDDINGS_API_KEY"
export const defaultBatchSize = 128

export const optionsFromEnv = (env: Record<string, string | undefined>, options: EnvOptions = {}): Options => {
  const embeddingsKey = nonEmpty(env.RIKA_EMBEDDINGS_API_KEY)
  if (embeddingsKey !== undefined)
    return { apiKey: Redacted.make(embeddingsKey, { label: defaultApiKeyEnv }), apiKeyEnv: defaultApiKeyEnv }

  const sharedKey = nonEmpty(env.RIKA_API_KEY)
  if (options.openaiConfigured === true && sharedKey !== undefined) {
    return {
      apiKey: Redacted.make(sharedKey, { label: OpenAi.defaultApiKeyEnv }),
      apiKeyEnv: defaultApiKeyEnv,
      fallbackApiKeyEnv: OpenAi.defaultApiKeyEnv,
    }
  }

  return { apiKey: undefined, fallbackApiKeyEnv: undefined }
}

export const layer = (options: Options = {}) => {
  const dimensions = options.dimensions ?? defaultDimensions
  const model = options.model ?? defaultModel
  const batchSize = options.batchSize ?? defaultBatchSize
  if (options.apiKey === undefined) {
    return Layer.succeed(
      Service,
      Service.of({
        dimensions,
        availability: Effect.succeed({ available: false, reason: `missing ${options.apiKeyEnv ?? defaultApiKeyEnv}` }),
        embed: Effect.fn("Embeddings.embed.unavailable")(function* () {
          return yield* new EmbeddingsUnavailable({
            message: `Embeddings require ${options.apiKeyEnv ?? defaultApiKeyEnv}`,
            key: options.apiKeyEnv ?? defaultApiKeyEnv,
          })
        }),
      }),
    )
  }

  const embeddingLayer = OpenAiEmbeddingModel.layer({
    model,
    config: { dimensions },
  }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiKey: options.apiKey,
        ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  )

  return Layer.succeed(
    Service,
    Service.of({
      dimensions,
      availability: Effect.succeed({ available: true, model, dimensions }),
      embed: Effect.fn("Embeddings.embed")(function* (texts: ReadonlyArray<string>) {
        const vectors = yield* Effect.forEach(
          chunks(texts, batchSize),
          (batch) => embedBatch(batch, model, dimensions),
          {
            concurrency: 1,
          },
        ).pipe(
          Effect.map((batches) => batches.flat()),
          Effect.provide(embeddingLayer),
          Effect.mapError((error) => toEmbeddingError(error, model, dimensions)),
        )
        return vectors
      }),
    }),
  )
}

export const fakeLayer = (options: { readonly dimensions?: number } = {}) => {
  const dimensions = options.dimensions ?? defaultDimensions
  return Layer.succeed(
    Service,
    Service.of({
      dimensions,
      availability: Effect.succeed({ available: true, model: "fake", dimensions }),
      embed: Effect.fn("Embeddings.embed.fake")(function* (texts: ReadonlyArray<string>) {
        return texts.map((text) => fakeVector(text, dimensions))
      }),
    }),
  )
}

export const embed = Effect.fn("Embeddings.embed.call")(function* (texts: ReadonlyArray<string>) {
  const embeddings = yield* Service
  return yield* embeddings.embed(texts)
})

const embedBatch = (
  texts: ReadonlyArray<string>,
  model: string,
  dimensions: number,
): Effect.Effect<
  ReadonlyArray<Float32Array>,
  EmbeddingsProviderError | EmbeddingsValidationError,
  EmbeddingModel.EmbeddingModel
> =>
  Effect.gen(function* () {
    const embeddings = yield* EmbeddingModel.EmbeddingModel
    const response = yield* embeddings.embedMany(texts).pipe(
      Effect.mapError(
        (error) =>
          new EmbeddingsProviderError({
            message: error.message,
            provider: "openai",
            model,
          }),
      ),
    )
    return yield* Effect.forEach(response.embeddings, (embedding) =>
      vectorFromNumbers(embedding.vector, model, dimensions),
    )
  })

const vectorFromNumbers = (
  vector: ReadonlyArray<number>,
  model: string,
  dimensions: number,
): Effect.Effect<Float32Array, EmbeddingsValidationError> =>
  Effect.gen(function* () {
    if (vector.length !== dimensions) {
      return yield* new EmbeddingsValidationError({
        message: `Embedding vector has ${vector.length} dimensions, expected ${dimensions}`,
        model,
        dimensions,
      })
    }
    const result = new Float32Array(vector.length)
    for (let index = 0; index < vector.length; index += 1) {
      const value = vector[index] ?? 0
      if (!Number.isFinite(value)) {
        return yield* new EmbeddingsValidationError({
          message: "Embedding vector contains a non-finite value",
          model,
          dimensions,
        })
      }
      result[index] = value
    }
    return result
  })

const toEmbeddingError = (
  error: EmbeddingsProviderError | EmbeddingsValidationError,
  model: string,
  dimensions: number,
) => {
  if (error instanceof EmbeddingsProviderError || error instanceof EmbeddingsValidationError) return error
  return new EmbeddingsValidationError({ message: String(error), model, dimensions })
}

const chunks = <A>(values: ReadonlyArray<A>, size: number) => {
  const result: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

const fakeVector = (text: string, dimensions: number) => {
  const vector = new Float32Array(dimensions)
  let state = 2166136261
  for (const char of text) {
    state ^= char.charCodeAt(0)
    state = Math.imul(state, 16777619)
  }
  for (let index = 0; index < dimensions; index += 1) {
    state ^= index + 1
    state = Math.imul(state, 16777619)
    vector[index] = ((state >>> 0) / 0xffffffff) * 2 - 1
  }
  return vector
}

const nonEmpty = (value: string | undefined) => (value === undefined || value.length === 0 ? undefined : value)
