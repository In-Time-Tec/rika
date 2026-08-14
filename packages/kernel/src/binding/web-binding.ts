import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "@batonfx/repl"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearchInput from "@rika/coding-tools/web-search-input-contract"
import { nested, NestedOperationFailed, operation, type Requirements } from "./nested-operation-envelope"

export const name = "web"

const Failure = Schema.Union([CodingToolResult.ToolFailure, NestedOperationFailed])

const Page = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })

const SearchInput = Schema.Struct({
  objective: WebSearchInput.Objective,
  searchQueries: WebSearchInput.SearchQueries,
  kind: Schema.optionalKey(WebSearchInput.Capability),
  strategy: Schema.optionalKey(WebSearchInput.Strategy),
  githubSearchType: Schema.optionalKey(WebSearchInput.GithubSearchType),
})

const ReadPageInput = Schema.Struct({
  url: Schema.String,
  objective: Schema.optionalKey(Schema.String),
  fullContent: Schema.optionalKey(Schema.Boolean),
  forceRefetch: Schema.optionalKey(Schema.Boolean),
})

const run = (request: typeof CodingToolRuntime.Request.Type) =>
  Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request))

const page = (result: CodingToolResult.Result) => ({ text: result.text, truncated: result.truncated })

export const operations: ReadonlyArray<HostBindingRegistry.AnyOperation<CodingToolRuntime.Service | Requirements>> = [
  operation({
    name: "search",
    input: SearchInput,
    output: Page,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "web.search", payload: input, replayPolicy: "provider-idempotent" },
        Effect.map(
          run({
            _tag: "WebSearch",
            objective: input.objective,
            searchQueries: input.searchQueries,
            ...(input.kind === undefined ? {} : { kind: input.kind }),
            ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
            ...(input.githubSearchType === undefined ? {} : { githubSearchType: input.githubSearchType }),
          }),
          page,
        ),
      ),
  }),
  operation({
    name: "readPage",
    input: ReadPageInput,
    output: Page,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "web.readPage", payload: input, replayPolicy: "provider-idempotent" },
        Effect.map(
          run({
            _tag: "ReadWebPage",
            url: input.url,
            ...(input.objective === undefined ? {} : { objective: input.objective }),
            ...(input.fullContent === undefined ? {} : { fullContent: input.fullContent }),
            ...(input.forceRefetch === undefined ? {} : { forceRefetch: input.forceRefetch }),
          }),
          page,
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<CodingToolRuntime.Service | Requirements> = { name, operations }
