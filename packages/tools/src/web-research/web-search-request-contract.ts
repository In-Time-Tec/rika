import { Schema } from "effect"
import { Capability, GithubSearchType, Objective, SearchQueries, Strategy } from "./web-search-input-contract"
export const SearchInput = Schema.Struct({
  objective: Objective,
  searchQueries: SearchQueries,
  kind: Schema.optionalKey(Capability),
  strategy: Schema.optionalKey(Strategy),
  githubSearchType: Schema.optionalKey(GithubSearchType),
})
export type SearchInput = typeof SearchInput.Type
