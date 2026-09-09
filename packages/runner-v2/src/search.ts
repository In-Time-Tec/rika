import { Context, Effect, Layer, Schema } from "effect"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384))
const SourceUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/i), Schema.isMaxLength(2_048))

export const SearchRequest = Schema.Struct({
  query: NonEmptyString,
  maxResults: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20))),
})
export type SearchRequest = typeof SearchRequest.Type

export const SearchItem = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(2_048)),
  url: SourceUrl,
  snippet: Schema.String.check(Schema.isMaxLength(16_384)),
})
export type SearchItem = typeof SearchItem.Type

/** Typed web-search output. Every returned item contributes a source URL. */
export const SearchResult = Schema.Struct({
  query: NonEmptyString,
  provider: NonEmptyString,
  results: Schema.Array(SearchItem).check(Schema.isMaxLength(20)),
  sourceUrls: Schema.Array(SourceUrl).check(Schema.isMaxLength(20)),
})
export type SearchResult = typeof SearchResult.Type

export const SearchFailureKind = Schema.Literals(["credentials", "invalid_input", "transport", "rate_limited"])
export type SearchFailureKind = typeof SearchFailureKind.Type

export class SearchProviderError extends Schema.TaggedError<SearchProviderError>()("RikaRunnerV2SearchProviderError", {
  kind: SearchFailureKind,
  message: Schema.String,
}) {}

export interface SearchProvider {
  readonly search: (request: SearchRequest) => Effect.Effect<SearchResult, SearchProviderError>
}

export class Search extends Context.Service<Search, SearchProvider>()("@rika/runner-v2/search") {}

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
  readonly results: ReadonlyMap<string, ReadonlyArray<SearchItem>> | ((query: string) => ReadonlyArray<SearchItem>)
}

const isSearchMap = (
  value: ScriptedSearchProviderOptions["results"],
): value is ReadonlyMap<string, ReadonlyArray<SearchItem>> => Schema.is(Schema.instanceOf(Map))(value)

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
  SearchItem,
  SearchProviderError,
  SearchRequest,
  SearchResult,
  missingSearchProvider,
  scriptedSearchProvider,
  searchProviderLayer,
}
