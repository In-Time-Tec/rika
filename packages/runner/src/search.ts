import { Context, Effect, Layer, Schema } from "effect"
import { SearchItem as SearchItemSchema, SearchResult as SearchResultSchema } from "@rika/execution/tools"
import type { SearchItem as SearchItemType, SearchResult as SearchResultType } from "@rika/execution/tools"

export { SearchItem, SearchResult } from "@rika/execution/tools"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))

export const SearchRequest = Schema.Struct({
  query: NonEmptyString,
  maxResults: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20))),
})
export type SearchRequest = typeof SearchRequest.Type

export const SearchFailureKind = Schema.Literals(["credentials", "invalid_input", "transport", "rate_limited"])
export type SearchFailureKind = typeof SearchFailureKind.Type

export class SearchProviderError extends Schema.TaggedError<SearchProviderError>()("RikaRunnerV2SearchProviderError", {
  kind: SearchFailureKind,
  message: Schema.String,
}) {}

export interface SearchProvider {
  readonly search: (request: SearchRequest) => Effect.Effect<SearchResultType, SearchProviderError>
}

export class Search extends Context.Service<Search, SearchProvider>()("@rika/runner/search") {}

export const missingSearchProvider: SearchProvider = {
  search: () =>
    Effect.fail(
      SearchProviderError.make({
        kind: "credentials",
        message: "Web search provider credentials are not configured",
      }),
    ),
}

export const searchProviderLayer = (provider: SearchProvider): Layer.Layer<Search> =>
  Layer.succeed(Search, Search.of(provider))

export interface ScriptedSearchProviderOptions {
  readonly provider?: string
  readonly results:
    | ReadonlyMap<string, ReadonlyArray<SearchItemType>>
    | ((query: string) => ReadonlyArray<SearchItemType>)
}

const isSearchMap = (
  value: ScriptedSearchProviderOptions["results"],
): value is ReadonlyMap<string, ReadonlyArray<SearchItemType>> => Schema.is(Schema.instanceOf(Map))(value)

/** Deterministic provider for local acceptance; output is labeled `scripted`. */
export const scriptedSearchProvider = (options: ScriptedSearchProviderOptions): SearchProvider => ({
  search: (request) => {
    const query = request.query.trim()
    if (query.length === 0)
      return Effect.fail(
        SearchProviderError.make({ kind: "invalid_input", message: "Web search query must not be empty" }),
      )
    const selected = isSearchMap(options.results) ? (options.results.get(query) ?? []) : options.results(query)
    const limit = request.maxResults ?? 10
    const results = selected.slice(0, limit)
    return Effect.succeed({
      query,
      provider: options.provider ?? "scripted",
      results,
      sourceUrls: [...new Set(results.map((result) => result.url))],
    })
  },
})

export const SearchContract = {
  Search,
  SearchFailureKind,
  SearchItem: SearchItemSchema,
  SearchProviderError,
  SearchRequest,
  SearchResult: SearchResultSchema,
  missingSearchProvider,
  scriptedSearchProvider,
  searchProviderLayer,
}
