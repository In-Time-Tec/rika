import { Schema } from "effect"

export const SearchQueries = Schema.Array(Schema.String).check(Schema.isMinLength(1))
export const Objective = Schema.String.check(Schema.isPattern(/\S/))
export const SearchInput = Schema.Struct({
  objective: Objective,
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
