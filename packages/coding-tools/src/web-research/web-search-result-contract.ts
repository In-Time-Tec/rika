import { Schema } from "effect"
export const SearchResult = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  excerpts: Schema.Array(Schema.String),
})
export type SearchResult = typeof SearchResult.Type
export const ProviderFailureKind = Schema.Literals(["authentication", "rate-limit", "timeout", "transport", "response"])
export type ProviderFailureKind = typeof ProviderFailureKind.Type
export class ProviderFailure extends Schema.TaggedError<ProviderFailure>()("WebSearchProviderFailure", {
  provider: Schema.String,
  kind: ProviderFailureKind,
  message: Schema.String,
}) {}
export const ProviderOutcome = Schema.Struct({
  provider: Schema.String,
  results: Schema.optionalKey(Schema.Array(SearchResult)),
  content: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(ProviderFailure),
})
export type ProviderOutcome = typeof ProviderOutcome.Type
