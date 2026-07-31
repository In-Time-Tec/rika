import { Context, Effect, Layer } from "effect"
import { HttpClient } from "effect/unstable/http"

import * as Request from "./web-search-request-contract"
import * as Result from "./web-search-result-contract"
import * as Provider from "./web-search-provider-contract"
import * as Errors from "./web-search-errors"

export interface Interface {
  readonly search: (
    input: Request.SearchInput,
  ) => Effect.Effect<ReadonlyArray<Result.ProviderOutcome>, Errors.SelectionError | Errors.ExecutionError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/coding-tools/web-research/web-search-service/Service",
) {}

const searchProvider = (provider: Provider.SearchProvider, request: Provider.SearchRequest) =>
  provider.search(request).pipe(
    Effect.catch((error) =>
      error.kind !== "transport"
        ? Effect.fail(error)
        : Effect.logWarning("tool.retry.scheduled").pipe(
            Effect.annotateLogs({
              "rika.tool.dependency": provider.id,
              "rika.tool.retry.attempt": 2,
              "rika.tool.retry.delay.ms": 200,
            }),
            Effect.andThen(Effect.sleep("200 millis")),
            Effect.andThen(provider.search(request)),
          ),
    ),
  )

const select = (providers: ReadonlyArray<Provider.SearchProvider>, input: Request.SearchInput) => {
  const kind = input.kind ?? "web"
  const capable = providers
    .filter((provider) => provider.capabilities.has(kind))
    .toSorted((a, b) => b.priority - a.priority)
  if (capable.length === 0)
    return Effect.fail(
      Errors.SelectionError.make({ message: `No configured web search provider supports '${kind}' searches` }),
    )
  return Effect.succeed(input.strategy === "compare" ? capable.slice(0, 3) : capable.slice(0, 1))
}

export const make = (providers: ReadonlyArray<Provider.SearchProvider>): Interface =>
  Service.of({
    search: Effect.fn("WebSearch.search")(function* (input) {
      const selected = yield* select(providers, input)
      const request: Provider.SearchRequest = {
        ...input,
        kind: input.kind ?? "web",
        strategy: input.strategy ?? "auto",
      }
      const outcomes: ReadonlyArray<Result.ProviderOutcome> = yield* Effect.forEach(
        selected,
        (provider) =>
          searchProvider(provider, request).pipe(
            Effect.map((outcome): Result.ProviderOutcome => ({ provider: provider.id, ...outcome })),
            Effect.catch(
              (error): Effect.Effect<Result.ProviderOutcome> => Effect.succeed({ provider: provider.id, error }),
            ),
          ),
        { concurrency: 3 },
      )
      if (outcomes.every((outcome) => outcome.error !== undefined))
        return yield* Errors.ExecutionError.make({
          message: `All selected web search providers failed: ${outcomes.map((outcome) => `${outcome.provider}: ${outcome.error?.message}`).join("; ")}`,
          outcomes,
        })
      return outcomes
    }),
  })

export const layer = (providers: ReadonlyArray<Provider.SearchProvider>) => Layer.succeed(Service, make(providers))
export type ProviderFactory = Effect.Effect<Provider.SearchProvider, never, HttpClient.HttpClient>
export const factoryLayer = (factories: ReadonlyArray<ProviderFactory>) =>
  Layer.effect(Service, Effect.map(Effect.all(factories, { concurrency: 5 }), make))
export const testLayer = (search: Interface["search"]) => Layer.succeed(Service, Service.of({ search }))
