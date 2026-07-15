import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const SearchQueries = Schema.Array(Schema.String).check(Schema.isMinLength(1))

export const SearchInput = Schema.Struct({
  objective: Schema.String,
  searchQueries: SearchQueries,
})
export type SearchInput = typeof SearchInput.Type

export const SearchResult = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  publishDate: Schema.NullOr(Schema.String),
  excerpts: Schema.Array(Schema.String),
})
export type SearchResult = typeof SearchResult.Type

const ApiSearchResult = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  publish_date: Schema.NullOr(Schema.String),
  excerpts: Schema.Array(Schema.String),
})

const ApiResponse = Schema.Struct({
  search_id: Schema.String,
  session_id: Schema.String,
  results: Schema.Array(ApiSearchResult),
})

export class SearchError extends Schema.TaggedErrorClass<SearchError>()("ParallelSearchError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly search: (input: SearchInput) => Effect.Effect<ReadonlyArray<SearchResult>, SearchError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/parallel-search/Service") {}

export interface LayerOptions {
  readonly apiKey?: Redacted.Redacted<string>
  readonly baseUrl?: string
}

const searchError = (cause: unknown) => SearchError.make({ message: String(cause) })

export const layer = (options: LayerOptions) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      return Service.of({
        search: Effect.fn("ParallelSearch.search")(function* (input) {
          if (options.apiKey === undefined) {
            return yield* SearchError.make({ message: "PARALLEL_API_KEY is not configured" })
          }
          const request = HttpClientRequest.post(`${options.baseUrl ?? "https://api.parallel.ai"}/v1/search`, {
            headers: { "x-api-key": Redacted.value(options.apiKey) },
          }).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              objective: input.objective,
              search_queries: input.searchQueries,
              mode: "advanced",
              max_chars_total: 40_000,
            }),
          )
          const response = yield* client
            .execute(request)
            .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ApiResponse)), Effect.mapError(searchError))
          return response.results.map((result) => ({
            url: result.url,
            title: result.title,
            publishDate: result.publish_date,
            excerpts: result.excerpts,
          }))
        }),
      })
    }),
  )

export const testLayer = (search: Interface["search"]) => Layer.succeed(Service, Service.of({ search }))
