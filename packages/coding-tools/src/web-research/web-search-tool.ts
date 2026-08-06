import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import * as Policy from "../policy/coding-tool-policy"
import * as Input from "./web-search-input-contract"
import { Result, ToolFailure } from "../runtime/coding-tool-result"
export const Request = Schema.Struct({
  _tag: Schema.tag("WebSearch"),
  objective: Input.Objective,
  searchQueries: Input.SearchQueries,
  kind: Schema.optionalKey(Input.Capability),
  strategy: Schema.optionalKey(Input.Strategy),
  githubSearchType: Schema.optionalKey(Input.GithubSearchType),
})
export const tool = Tool.make("web_search", {
  description:
    "Search configured sources. Use code for public semantic implementation examples, github through the configured GitHub search provider for private or access-controlled and exact GitHub-oriented searches, and web for general research.",
  parameters: Schema.Struct({
    objective: Input.Objective,
    searchQueries: Input.SearchQueries,
    kind: Schema.optionalKey(Input.Capability),
    strategy: Schema.optionalKey(Input.Strategy),
    githubSearchType: Schema.optionalKey(Input.GithubSearchType),
  }),
  success: Result,
  failure: ToolFailure,
  failureMode: "return",
})
export const registration = Policy.register(
  tool,
  Policy.allow("safe", 30_000, 40_000, {
    family: "direct",
    action: "web-search",
    activeLabel: "Web Search",
    completeLabel: "Web Search",
    outputDisplay: "expandable",
    counter: "web search",
  }),
)
