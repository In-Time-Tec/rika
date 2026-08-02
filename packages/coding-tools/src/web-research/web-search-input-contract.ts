import { Schema } from "effect"
export const Objective = Schema.String.check(Schema.isPattern(/\S/))
const Query = Schema.String.check(Schema.isPattern(/\S/))
export const SearchQueries = Schema.Array(Query).check(Schema.isMinLength(1))
export const Capability = Schema.Literals(["web", "code", "github"])
export type Capability = typeof Capability.Type
export const Strategy = Schema.Literals(["auto", "compare"])
export type Strategy = typeof Strategy.Type
export const GithubSearchType = Schema.Literals(["code", "repositories", "issues", "commits"])
export type GithubSearchType = typeof GithubSearchType.Type
