import { Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import Parallel from "parallel-web"
import * as WebSearch from "./web-search"

export interface ProviderOptions {
  readonly apiKey?: Redacted.Redacted<string>
  readonly baseUrl?: string
  readonly priority?: number
  readonly fetch?: typeof globalThis.fetch
}

const unknownJson = Schema.UnknownFromJsonString
const decodeBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.text.pipe(Effect.flatMap(Schema.decodeEffect(unknownJson)))

const failure = (provider: string, kind: WebSearch.ProviderFailureKind, message: string) =>
  WebSearch.ProviderFailure.make({ provider, kind, message })

const mapTransport = (provider: string, cause: unknown) => {
  const message = String(cause)
  return failure(provider, /timeout|timed out/i.test(message) ? "timeout" : "transport", message)
}

const mapSdkFailure = (provider: string, cause: unknown) => {
  const status =
    typeof cause === "object" && cause !== null && "status" in cause && typeof cause.status === "number"
      ? cause.status
      : undefined
  if (status === 401 || status === 403) return failure(provider, "authentication", `HTTP ${status}`)
  if (status === 429) return failure(provider, "rate-limit", `HTTP ${status}`)
  return mapTransport(provider, cause)
}

const execute = (
  client: HttpClient.HttpClient,
  provider: string,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<unknown, WebSearch.ProviderFailure> =>
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
    return yield* decodeBody(response).pipe(
      Effect.mapError((cause) => failure(provider, "response", `Malformed response: ${String(cause)}`)),
    )
  })

const credential = (provider: string, name: string, apiKey: ProviderOptions["apiKey"]) =>
  apiKey === undefined
    ? Effect.fail(failure(provider, "authentication", `${name} is not configured`))
    : Effect.succeed(Redacted.value(apiKey))

const object = (provider: string, value: unknown): Effect.Effect<Record<string, unknown>, WebSearch.ProviderFailure> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Effect.succeed(value as Record<string, unknown>)
    : Effect.fail(failure(provider, "response", "Malformed response: expected an object"))

const array = (value: unknown) => (Array.isArray(value) ? value : [])
const text = (value: unknown) => (typeof value === "string" ? value : null)
const excerpts = (value: unknown) => array(value).flatMap((item) => (typeof item === "string" ? [item] : []))
const urlResult = (
  item: Record<string, unknown>,
  excerptValues: ReadonlyArray<string>,
): WebSearch.SearchResult | undefined => {
  const url = text(item.url) ?? text(item.html_url)
  if (url === null) return undefined
  return {
    url,
    title: text(item.title) ?? text(item.name) ?? text(item.full_name),
    publishedAt:
      text(item.publishedAt) ?? text(item.published_date) ?? text(item.publish_date) ?? text(item.created_at),
    excerpts: excerptValues,
  }
}

const makeParallel = (_client: HttpClient.HttpClient, options: ProviderOptions): WebSearch.SearchProvider => ({
  id: "parallel",
  capabilities: new Set(["web"]),
  priority: options.priority ?? 100,
  search: (request) =>
    Effect.gen(function* () {
      const key = yield* credential("parallel", "PARALLEL_API_KEY", options.apiKey)
      const client = new Parallel({
        apiKey: key,
        baseURL: options.baseUrl,
        maxRetries: 0,
        timeout: 30_000,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      })
      const response = yield* Effect.callback<Parallel.SearchResult, WebSearch.ProviderFailure>((resume) => {
        const controller = new AbortController()
        client
          .search(
            {
              objective: request.objective,
              search_queries: [...request.searchQueries],
              mode: "advanced",
              max_chars_total: 40_000,
            },
            { signal: controller.signal, maxRetries: 0 },
          )
          .then(
            (result) => resume(Effect.succeed(result)),
            (cause: unknown) => resume(Effect.fail(mapSdkFailure("parallel", cause))),
          )
        return Effect.sync(() => controller.abort())
      })
      return {
        results: response.results.map((result) => ({
          url: result.url,
          title: result.title ?? null,
          publishedAt: result.publish_date ?? null,
          excerpts: result.excerpts,
        })),
      }
    }),
})

const exaHeaders = (key: string) => ({ "x-api-key": key })
const combinedQuery = (request: WebSearch.SearchRequest) => [request.objective, ...request.searchQueries].join("\n")

const makeExa = (client: HttpClient.HttpClient, options: ProviderOptions): WebSearch.SearchProvider => ({
  id: "exa",
  capabilities: new Set(["web", "code"]),
  priority: options.priority ?? 90,
  search: (request) =>
    Effect.gen(function* () {
      const key = yield* credential("exa", "EXA_API_KEY", options.apiKey)
      const code = request.kind === "code"
      const body = yield* execute(
        client,
        "exa",
        HttpClientRequest.post(`${options.baseUrl ?? "https://api.exa.ai"}/${code ? "context" : "search"}`, {
          headers: exaHeaders(key),
        }).pipe(
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
        ),
      )
      const root = yield* object("exa", body)
      if (code) {
        const content = text(root.response) ?? text(root.context) ?? text(root.content)
        if (content === null) return yield* failure("exa", "response", "Malformed response: formatted context missing")
        return { content }
      }
      if (!Array.isArray(root.results)) return yield* failure("exa", "response", "Malformed response: results missing")
      return {
        results: root.results.flatMap((value) => {
          if (typeof value !== "object" || value === null) return []
          const item = value as Record<string, unknown>
          const result = urlResult(item, excerpts(item.highlights))
          return result === undefined ? [] : [result]
        }),
      }
    }),
})

const makeFirecrawl = (client: HttpClient.HttpClient, options: ProviderOptions): WebSearch.SearchProvider => ({
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
      )
      const root = yield* object("firecrawl", body)
      const data = yield* object("firecrawl", root.data)
      if (!Array.isArray(data.web))
        return yield* failure("firecrawl", "response", "Malformed response: data.web missing")
      return {
        results: data.web.flatMap((value) => {
          if (typeof value !== "object" || value === null) return []
          const item = value as Record<string, unknown>
          const description = text(item.description)
          const result = urlResult(item, description === null ? [] : [description])
          return result === undefined ? [] : [result]
        }),
      }
    }),
})

const githubExcerpts = (item: Record<string, unknown>) => {
  const matches = array(item.text_matches).flatMap((match) => {
    if (typeof match !== "object" || match === null) return []
    const record = match as Record<string, unknown>
    return excerpts(record.fragments).concat(text(record.fragment) ?? [])
  })
  return matches.concat([item.body, item.description].flatMap((value) => (typeof value === "string" ? [value] : [])))
}

const makeGithub = (client: HttpClient.HttpClient, options: ProviderOptions): WebSearch.SearchProvider => ({
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
      )
      const root = yield* object("github", body)
      if (!Array.isArray(root.items)) return yield* failure("github", "response", "Malformed response: items missing")
      return {
        results: root.items.flatMap((value) => {
          if (typeof value !== "object" || value === null) return []
          const item = value as Record<string, unknown>
          const result = urlResult(item, githubExcerpts(item))
          return result === undefined ? [] : [result]
        }),
      }
    }),
})

const providerFactory =
  (make: (client: HttpClient.HttpClient, options: ProviderOptions) => WebSearch.SearchProvider) =>
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

export const providerAvailability = (credentials: Readonly<Record<string, Redacted.Redacted<string>>>) => ({
  search: providerRegistry.some((provider) => credentials[provider.id] !== undefined),
  readPage: configuredReadPageCredential(credentials) !== undefined,
})
