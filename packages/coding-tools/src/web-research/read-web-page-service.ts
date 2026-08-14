import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Input } from "./read-web-page-contract"

export class HttpError extends Schema.TaggedErrorClass<HttpError>()("ReadWebPageHttpError", {
  message: Schema.String,
}) {}

export class ContentError extends Schema.TaggedErrorClass<ContentError>()("ReadWebPageContentError", {
  reason: Schema.Literals(["invalid_input", "content_unavailable"]),
  message: Schema.String,
}) {}

export type Error = HttpError | ContentError

export interface Interface {
  readonly read: (input: Input) => Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/coding-tools/web-research/read-web-page-service/Service",
) {}

export interface LayerOptions {
  readonly apiKey?: Redacted.Redacted<string>
  readonly baseUrl?: string
}

const ApiResult = Schema.Struct({
  url: Schema.String,
  title: Schema.optionalKey(Schema.NullOr(Schema.String)),
  publish_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
  excerpts: Schema.Array(Schema.String),
  full_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const ApiExtractionError = Schema.Struct({
  url: Schema.String,
  error_type: Schema.String,
  http_status_code: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  content: Schema.NullOr(Schema.String),
})

const ApiResponse = Schema.Struct({
  extract_id: Schema.String,
  results: Schema.Array(ApiResult),
  errors: Schema.Array(ApiExtractionError),
  session_id: Schema.String,
})

const validateUrl = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value)
      if (url.protocol === "file:")
        throw new Error(
          "read_web_page does not support file:// URLs; use rika.workspace.read or a local-capable Task or Oracle child",
        )
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("read_web_page supports only public HTTP(S) URLs")
      if (url.username !== "" || url.password !== "") throw new Error("URL credentials are not allowed")
      return url.toString()
    },
    catch: (cause) => ContentError.make({ reason: "invalid_input", message: `Invalid URL: ${String(cause)}` }),
  })

const httpError = (cause: unknown) => HttpError.make({ message: String(cause) })

export const layer = (options: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      return Service.of({
        read: Effect.fn("ReadWebPage.read")(function* (input) {
          const url = yield* validateUrl(input.url)
          if (options.apiKey === undefined) {
            return yield* HttpError.make({ message: "PARALLEL_API_KEY is not configured" })
          }
          const advancedSettings = {
            ...(input.fullContent === true ? { full_content: true } : {}),
            ...(input.forceRefetch === true
              ? { fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true } }
              : {}),
          }
          const request = HttpClientRequest.post(`${options.baseUrl ?? "https://api.parallel.ai"}/v1/extract`, {
            headers: { "x-api-key": Redacted.value(options.apiKey) },
          }).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              urls: [url],
              ...(input.objective === undefined ? {} : { objective: input.objective }),
              max_chars_total: 40_000,
              ...(Object.keys(advancedSettings).length === 0 ? {} : { advanced_settings: advancedSettings }),
            }),
          )
          const response = yield* client
            .execute(request)
            .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ApiResponse)), Effect.mapError(httpError))
          if (response.errors.length > 0) {
            return yield* ContentError.make({
              reason: "content_unavailable",
              message: response.errors
                .map(
                  (error) =>
                    `${error.url}: ${error.error_type}${error.http_status_code == null ? "" : ` (${error.http_status_code})`}: ${error.content}`,
                )
                .join("\n"),
            })
          }
          if (response.results.length === 0) {
            return yield* ContentError.make({
              reason: "content_unavailable",
              message: `Extract ${response.extract_id} returned no results`,
            })
          }
          if (input.fullContent === true) {
            const missing = response.results.find((result) => result.full_content == null)
            if (missing !== undefined) {
              return yield* ContentError.make({
                reason: "content_unavailable",
                message: `Parallel returned no full content for ${missing.url}`,
              })
            }
            return response.results.map((result) => result.full_content!).join("\n\n")
          }
          return response.results.flatMap((result) => result.excerpts).join("\n\n")
        }),
      })
    }),
  )

export const testLayer = (read: Interface["read"]) => Layer.succeed(Service, Service.of({ read }))
