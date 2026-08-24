import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Request from "./provider-contract"
import * as Result from "./result"
import type { ProviderOptions } from "./provider-options"

const OptionalString = Schema.optionalKey(Schema.NullOr(Schema.String))
const SearchResultItem = Schema.Struct({
  url: OptionalString,
  html_url: OptionalString,
  title: OptionalString,
  name: OptionalString,
  full_name: OptionalString,
  publishedAt: OptionalString,
  published_date: OptionalString,
  publish_date: OptionalString,
  created_at: OptionalString,
})
type SearchResultItem = typeof SearchResultItem.Type

const ParallelItem = Schema.Struct({
  ...SearchResultItem.fields,
  excerpts: Schema.optionalKey(Schema.Array(Schema.String)),
})
const ParallelPayload = Schema.Struct({ results: Schema.optionalKey(Schema.Array(ParallelItem)) })
const ExaSearchItem = Schema.Struct({
  ...SearchResultItem.fields,
  highlights: Schema.optionalKey(Schema.Array(Schema.String)),
})
const ExaSearchPayload = Schema.Struct({ results: Schema.optionalKey(Schema.Array(ExaSearchItem)) })
const ExaContextPayload = Schema.Struct({ response: OptionalString, context: OptionalString, content: OptionalString })
const FirecrawlItem = Schema.Struct({ ...SearchResultItem.fields, description: OptionalString })
const FirecrawlPayload = Schema.Struct({
  data: Schema.optionalKey(Schema.Struct({ web: Schema.optionalKey(Schema.Array(FirecrawlItem)) })),
})
const GithubTextMatch = Schema.Struct({
  fragments: Schema.optionalKey(Schema.Array(Schema.String)),
  fragment: OptionalString,
})
const GithubItem = Schema.Struct({
  ...SearchResultItem.fields,
  text_matches: Schema.optionalKey(Schema.Array(GithubTextMatch)),
  body: OptionalString,
  description: OptionalString,
})
const GithubPayload = Schema.Struct({ items: Schema.optionalKey(Schema.Array(GithubItem)) })

const decodeParallelPayload = Schema.decodeEffect(Schema.fromJsonString(ParallelPayload))
const decodeExaSearchPayload = Schema.decodeEffect(Schema.fromJsonString(ExaSearchPayload))
const decodeExaContextPayload = Schema.decodeEffect(Schema.fromJsonString(ExaContextPayload))
const decodeFirecrawlPayload = Schema.decodeEffect(Schema.fromJsonString(FirecrawlPayload))
const decodeGithubPayload = Schema.decodeEffect(Schema.fromJsonString(GithubPayload))

const failure = (provider: string, kind: Result.ProviderFailureKind, message: string) =>
  Result.ProviderFailure.make({ provider, kind, message })

const mapTransport = (provider: string, cause: unknown) => {
  const message = String(cause)
  return failure(provider, /timeout|timed out/i.test(message) ? "timeout" : "transport", message)
}

const execute = <A, E>(
  client: HttpClient.HttpClient,
  provider: string,
  request: HttpClientRequest.HttpClientRequest,
  decode: (text: string) => Effect.Effect<A, E>,
): Effect.Effect<A, Result.ProviderFailure> =>
  Effect.gen(function* () {
    const response = yield* client.execute(request).pipe(Effect.mapError((cause) => mapTransport(provider, cause)))
    if (response.status < 200 || response.status >= 300) {
      const remaining = Number(response.headers["x-ratelimit-remaining"])
      if (response.status === 429 || (response.status === 403 && remaining === 0))
        return yield* failure(provider, "rate-limit", `HTTP ${response.status}`)
      if (response.status === 401 || response.status === 403)
        return yield* failure(provider, "authentication", `HTTP ${response.status}`)
      return yield* failure(provider, "response", `HTTP ${response.status}`)
    }
    return yield* response.text.pipe(
      Effect.flatMap(decode),
      Effect.mapError((cause) => failure(provider, "response", `Malformed response: ${String(cause)}`)),
    )
  })

const credential = (provider: string, name: string, apiKey: ProviderOptions["apiKey"]) =>
  apiKey === undefined
    ? Effect.fail(failure(provider, "authentication", `${name} is not configured`))
    : Effect.succeed(Redacted.value(apiKey))

const urlResult = (item: SearchResultItem, excerptValues: ReadonlyArray<string>): Result.SearchResult | undefined => {
  const url = item.url ?? item.html_url
  if (url === undefined || url === null) return undefined
  return {
    url,
    title: item.title ?? item.name ?? item.full_name ?? null,
    publishedAt: item.publishedAt ?? item.published_date ?? item.publish_date ?? item.created_at ?? null,
    excerpts: excerptValues,
  }
}

const makeParallel = (client: HttpClient.HttpClient, options: ProviderOptions): Request.SearchProvider => ({
  id: "parallel",
  capabilities: new Set(["web"]),
  priority: options.priority ?? 100,
  search: (request) =>
    Effect.gen(function* () {
      const key = yield* credential("parallel", "PARALLEL_API_KEY", options.apiKey)
      const body = yield* execute(
        client,
        "parallel",
        HttpClientRequest.post(`${options.baseUrl ?? "https://api.parallel.ai"}/v1/search`, {
          headers: { "x-api-key": key },
        }).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            objective: request.objective,
            search_queries: [...request.searchQueries],
            mode: "advanced",
            max_chars_total: 40_000,
          }),
        ),
        decodeParallelPayload,
      )
      if (body.results === undefined)
        return yield* failure("parallel", "response", "Malformed response: results missing")
      return {
        results: body.results.flatMap((item) => {
          const result = urlResult(item, item.excerpts ?? [])
          return result === undefined ? [] : [result]
        }),
      }
    }),
})

const exaHeaders = (key: string) => ({ "x-api-key": key })
const combinedQuery = (request: Request.SearchRequest) => [request.objective, ...request.searchQueries].join("\n")

const makeExa = (client: HttpClient.HttpClient, options: ProviderOptions): Request.SearchProvider => ({
  id: "exa",
  capabilities: new Set(["web", "code"]),
  priority: options.priority ?? 90,
  search: (request) =>
    Effect.gen(function* () {
      const key = yield* credential("exa", "EXA_API_KEY", options.apiKey)
      const code = request.kind === "code"
      const httpRequest = HttpClientRequest.post(
        `${options.baseUrl ?? "https://api.exa.ai"}/${code ? "context" : "search"}`,
        {
          headers: exaHeaders(key),
        },
      ).pipe(
        HttpClientRequest.bodyJsonUnsafe(
          code
            ? { query: combinedQuery(request), tokensNum: "dynamic" }
            : {
                query: combinedQuery(request),
                type: "fast",
                numResults: Math.min(10, Math.max(1, request.searchQueries.length * 3)),
                contents: { highlights: true },
              },
        ),
      )
      if (code) {
        const body = yield* execute(client, "exa", httpRequest, decodeExaContextPayload)
        const content = body.response ?? body.context ?? body.content
        if (content === undefined || content === null)
          return yield* failure("exa", "response", "Malformed response: formatted context missing")
        return { content }
      }
      const body = yield* execute(client, "exa", httpRequest, decodeExaSearchPayload)
      if (body.results === undefined) return yield* failure("exa", "response", "Malformed response: results missing")
      return {
        results: body.results.flatMap((item) => {
          const result = urlResult(item, item.highlights ?? [])
          return result === undefined ? [] : [result]
        }),
      }
    }),
})

const makeFirecrawl = (client: HttpClient.HttpClient, options: ProviderOptions): Request.SearchProvider => ({
  id: "firecrawl",
  capabilities: new Set(["web"]),
  priority: options.priority ?? 80,
  search: (request) =>
    Effect.gen(function* () {
      const key = yield* credential("firecrawl", "FIRECRAWL_API_KEY", options.apiKey)
      const body = yield* execute(
        client,
        "firecrawl",
        HttpClientRequest.post(`${options.baseUrl ?? "https://api.firecrawl.dev"}/v2/search`, {
          headers: { authorization: `Bearer ${key}` },
        }).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            query: combinedQuery(request),
            limit: Math.min(10, Math.max(1, request.searchQueries.length * 2)),
          }),
        ),
        decodeFirecrawlPayload,
      )
      if (body.data?.web === undefined)
        return yield* failure("firecrawl", "response", "Malformed response: data.web missing")
      return {
        results: body.data.web.flatMap((item) => {
          const result = urlResult(
            item,
            item.description === undefined || item.description === null ? [] : [item.description],
          )
          return result === undefined ? [] : [result]
        }),
      }
    }),
})

const githubExcerpts = (item: typeof GithubItem.Type) => {
  const matches = (item.text_matches ?? []).flatMap((match) =>
    (match.fragments ?? []).concat(match.fragment === undefined || match.fragment === null ? [] : [match.fragment]),
  )
  return matches.concat(
    item.body === undefined || item.body === null ? [] : [item.body],
    item.description === undefined || item.description === null ? [] : [item.description],
  )
}

const makeGithub = (client: HttpClient.HttpClient, options: ProviderOptions): Request.SearchProvider => ({
  id: "github",
  capabilities: new Set(["github"]),
  priority: options.priority ?? 100,
  search: (request) =>
    Effect.gen(function* () {
      const key = yield* credential("github", "GITHUB_TOKEN", options.apiKey)
      const type = request.githubSearchType ?? "code"
      const endpoint = type === "repositories" ? "repositories" : type
      const query = encodeURIComponent(request.searchQueries.join(" "))
      const body = yield* execute(
        client,
        "github",
        HttpClientRequest.get(
          `${options.baseUrl ?? "https://api.github.com"}/search/${endpoint}?q=${query}&per_page=10`,
          {
            headers: {
              authorization: `Bearer ${key}`,
              accept: "application/vnd.github+json, application/vnd.github.text-match+json",
              "x-github-api-version": "2022-11-28",
            },
          },
        ),
        decodeGithubPayload,
      )
      if (body.items === undefined) return yield* failure("github", "response", "Malformed response: items missing")
      return {
        results: body.items.flatMap((item) => {
          const result = urlResult(item, githubExcerpts(item))
          return result === undefined ? [] : [result]
        }),
      }
    }),
})

const providerFactory =
  (make: (client: HttpClient.HttpClient, options: ProviderOptions) => Request.SearchProvider) =>
  (options: ProviderOptions) =>
    Effect.map(HttpClient.HttpClient, (client) => make(client, options))

export const parallel = providerFactory(makeParallel)
export const exa = providerFactory(makeExa)
export const firecrawl = providerFactory(makeFirecrawl)
export const github = providerFactory(makeGithub)

export const providerRegistry = [
  {
    id: "parallel",
    capabilities: ["web"],
    priority: 100,
    credentialEnvironment: "PARALLEL_API_KEY",
    search: parallel,
    readPage: true,
  },
  {
    id: "exa",
    capabilities: ["web", "code"],
    priority: 90,
    credentialEnvironment: "EXA_API_KEY",
    search: exa,
    readPage: false,
  },
  {
    id: "firecrawl",
    capabilities: ["web"],
    priority: 80,
    credentialEnvironment: "FIRECRAWL_API_KEY",
    search: firecrawl,
    readPage: false,
  },
  {
    id: "github",
    capabilities: ["github"],
    priority: 100,
    credentialEnvironment: "GITHUB_TOKEN",
    search: github,
    readPage: false,
  },
] as const

export type ProviderId = (typeof providerRegistry)[number]["id"]

export const configuredProviderFactories = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => {
  const configured = Object.keys(credentials)
  const unsupportedIds = configured.filter((id) => !providerRegistry.some((provider) => provider.id === id))
  const factories = providerRegistry.flatMap((descriptor) => {
    const apiKey = credentials[descriptor.id]
    return apiKey === undefined ? [] : [descriptor.search({ apiKey, priority: descriptor.priority })]
  })
  return { factories, unsupportedIds }
}

export const configuredReadPageCredential = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => {
  const descriptor = providerRegistry.find((provider) => provider.readPage && credentials[provider.id] !== undefined)
  return descriptor === undefined ? undefined : credentials[descriptor.id]
}
