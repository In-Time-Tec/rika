import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"

export const Objective = Schema.String.check(Schema.isPattern(/\S/))
export const SearchQueries = Schema.Array(Schema.String).check(Schema.isMinLength(1))
export const Capability = Schema.Literals(["web", "code", "github"])
export type Capability = typeof Capability.Type
export const Strategy = Schema.Literals(["auto", "compare"])
export type Strategy = typeof Strategy.Type
export const GithubSearchType = Schema.Literals(["code", "repositories", "issues", "commits"])
export type GithubSearchType = typeof GithubSearchType.Type

export const SearchInput = Schema.Struct({
  objective: Objective,
  searchQueries: SearchQueries,
  kind: Schema.optionalKey(Capability),
  strategy: Schema.optionalKey(Strategy),
  providers: Schema.optionalKey(Schema.Array(Schema.String)),
  githubSearchType: Schema.optionalKey(GithubSearchType),
})
export type SearchInput = typeof SearchInput.Type

export interface SearchRequest extends SearchInput {
  readonly kind: Capability
  readonly strategy: Strategy
}

export const SearchResult = Schema.Struct({
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  publishedAt: Schema.NullOr(Schema.String),
  excerpts: Schema.Array(Schema.String),
})
export type SearchResult = typeof SearchResult.Type

export const ProviderFailureKind = Schema.Literals(["authentication", "rate-limit", "timeout", "transport", "response"])
export type ProviderFailureKind = typeof ProviderFailureKind.Type

export class ProviderFailure extends Schema.TaggedErrorClass<ProviderFailure>()("WebSearchProviderFailure", {
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

export class SelectionError extends Schema.TaggedErrorClass<SelectionError>()("WebSearchSelectionError", {
  message: Schema.String,
}) {}

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("WebSearchExecutionError", {
  message: Schema.String,
  outcomes: Schema.Array(ProviderOutcome),
}) {}

export interface SearchProvider {
  readonly id: string
  readonly capabilities: ReadonlySet<Capability>
  readonly priority: number
  readonly search: (
    request: SearchRequest,
  ) => Effect.Effect<Omit<ProviderOutcome, "provider" | "error">, ProviderFailure>
}

export interface Interface {
  readonly search: (
    input: SearchInput,
  ) => Effect.Effect<ReadonlyArray<ProviderOutcome>, SelectionError | ExecutionError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/tools/web-search/Service") {}

const select = (providers: ReadonlyArray<SearchProvider>, input: SearchInput) => {
  const kind = input.kind ?? "web"
  const explicit = input.providers
  if (explicit !== undefined) {
    if (explicit.length === 0) return Effect.fail(SelectionError.make({ message: "providers must not be empty" }))
    if (explicit.length > 3)
      return Effect.fail(SelectionError.make({ message: "At most 3 explicit web search providers may be selected" }))
    const duplicates = explicit.filter((id, index) => explicit.indexOf(id) !== index)
    if (duplicates.length > 0)
      return Effect.fail(
        SelectionError.make({ message: `Duplicate web search provider IDs: ${[...new Set(duplicates)].join(", ")}` }),
      )
    const selected: Array<SearchProvider> = []
    for (const id of explicit) {
      const provider = providers.find((candidate) => candidate.id === id)
      if (provider === undefined)
        return Effect.fail(SelectionError.make({ message: `Web search provider '${id}' is unavailable` }))
      if (!provider.capabilities.has(kind))
        return Effect.fail(
          SelectionError.make({ message: `Web search provider '${id}' does not support '${kind}' searches` }),
        )
      selected.push(provider)
    }
    return Effect.succeed(selected)
  }
  const capable = providers
    .filter((provider) => provider.capabilities.has(kind))
    .toSorted((a, b) => b.priority - a.priority)
  if (capable.length === 0)
    return Effect.fail(
      SelectionError.make({ message: `No configured web search provider supports '${kind}' searches` }),
    )
  return Effect.succeed(input.strategy === "compare" ? capable.slice(0, 3) : capable.slice(0, 1))
}

export const make = (providers: ReadonlyArray<SearchProvider>): Interface =>
  Service.of({
    search: Effect.fn("WebSearch.search")(function* (input) {
      const selected = yield* select(providers, input)
      const request: SearchRequest = { ...input, kind: input.kind ?? "web", strategy: input.strategy ?? "auto" }
      const outcomes: ReadonlyArray<ProviderOutcome> = yield* Effect.forEach(
        selected,
        (provider) =>
          provider.search(request).pipe(
            Effect.map((outcome): ProviderOutcome => ({ provider: provider.id, ...outcome })),
            Effect.catch((error): Effect.Effect<ProviderOutcome> => Effect.succeed({ provider: provider.id, error })),
          ),
        { concurrency: 3 },
      )
      if (outcomes.every((outcome) => outcome.error !== undefined))
        return yield* ExecutionError.make({
          message: `All selected web search providers failed: ${outcomes.map((outcome) => `${outcome.provider}: ${outcome.error?.message}`).join("; ")}`,
          outcomes,
        })
      return outcomes
    }),
  })

export const layer = (providers: ReadonlyArray<SearchProvider>) => Layer.succeed(Service, make(providers))
export type ProviderFactory = Effect.Effect<SearchProvider, never, HttpClient.HttpClient>
export const factoryLayer = (factories: ReadonlyArray<ProviderFactory>) =>
  Layer.effect(Service, Effect.map(Effect.all(factories, { concurrency: 5 }), make))
export const testLayer = (search: Interface["search"]) => Layer.succeed(Service, Service.of({ search }))

export { exa, firecrawl, github, parallel } from "./web-search-providers"
export type { ProviderOptions } from "./web-search-providers"
