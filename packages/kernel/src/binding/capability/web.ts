import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearchInput from "@rika/coding-tools/web-search-input-contract"
import { nested, NestedOperationFailed, operation, type Requirements } from "../envelope"

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
    handle: (input) => {
      const request = CodingToolRuntime.Request.make({
        _tag: "WebSearch",
        objective: input.objective,
        searchQueries: input.searchQueries,
      })
      if (input.kind !== undefined) Object.assign(request, { kind: input.kind })
      if (input.strategy !== undefined) Object.assign(request, { strategy: input.strategy })
      if (input.githubSearchType !== undefined) Object.assign(request, { githubSearchType: input.githubSearchType })
      return nested(
        { kind: "web.search", payload: input, replayPolicy: "provider-idempotent" },
        Effect.map(run(request), page),
      )
    },
  }),
  operation({
    name: "readPage",
    input: ReadPageInput,
    output: Page,
    failure: Failure,
    handle: (input) => {
      const request = CodingToolRuntime.Request.make({
        _tag: "ReadWebPage",
        url: input.url,
      })
      if (input.objective !== undefined) Object.assign(request, { objective: input.objective })
      if (input.fullContent !== undefined) Object.assign(request, { fullContent: input.fullContent })
      if (input.forceRefetch !== undefined) Object.assign(request, { forceRefetch: input.forceRefetch })
      return nested(
        { kind: "web.readPage", payload: input, replayPolicy: "provider-idempotent" },
        Effect.map(run(request), page),
      )
    },
  }),
]

export const module: HostBindingRegistry.Module<CodingToolRuntime.Service | Requirements> = { name, operations }
