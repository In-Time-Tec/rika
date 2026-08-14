import * as WebSearchInput from "../src/web-research/web-search-input-contract"
import * as WebSearchResult from "../src/web-research/web-search-result-contract"
import * as WebSearchProvider from "../src/web-research/web-search-provider-contract"
import * as WebSearchProviderImpl from "@rika/coding-tools/web-search-provider"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { provide } from "./test-layer"

const input = { objective: "Find current docs", searchQueries: ["current docs"] } as const
const result = { url: "https://example.com", title: null, publishedAt: null, excerpts: ["match"] }
const makeProvider = (
  id: string,
  priority: number,
  capabilities: ReadonlyArray<WebSearchInput.Capability> = ["web"],
  search: WebSearchProvider.SearchProvider["search"] = () => Effect.succeed({ results: [result] }),
): WebSearchProvider.SearchProvider => ({ id, priority, capabilities: new Set(capabilities), search })

const response = (httpRequest: HttpClientRequest.HttpClientRequest, body: unknown, status = 200, headers = {}) =>
  HttpClientResponse.fromWeb(
    httpRequest,
    new Response(Schema.encodeSync(Schema.UnknownFromJsonString)(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  )

const clientLayer = (
  run: (httpRequest: HttpClientRequest.HttpClientRequest) => HttpClientResponse.HttpClientResponse,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((httpRequest) => Effect.succeed(run(httpRequest))),
  )

const body = (httpRequest: HttpClientRequest.HttpClientRequest) => {
  if (httpRequest.body._tag !== "Uint8Array") throw new Error("Expected JSON body")
  return Schema.decodeSync(Schema.UnknownFromJsonString)(new TextDecoder().decode(httpRequest.body.body))
}

describe("WebSearch registry", () => {
  it("selects the read-page credential and reserves GitHub-kind search for GitHub through the provider registry", () => {
    const parallel = Redacted.make("parallel")
    expect(WebSearchProviderImpl.configuredReadPageCredential({ exa: Redacted.make("exa") })).toBeUndefined()
    expect(WebSearchProviderImpl.configuredReadPageCredential({ exa: Redacted.make("exa"), parallel })).toBe(parallel)
    expect(
      WebSearchProviderImpl.providerRegistry.flatMap(({ id, capabilities }) =>
        capabilities.some((capability) => capability === "github") ? [id] : [],
      ),
    ).toEqual(["github"])
  })

  it.effect("selects by priority and compares at most three providers without deduplication", () =>
    Effect.gen(function* () {
      const search = WebSearch.make([
        makeProvider("low", 1),
        makeProvider("high", 3),
        makeProvider("middle", 2),
        makeProvider("fourth", 0),
      ])
      expect((yield* search.search(input)).map((outcome) => outcome.provider)).toEqual(["high"])
      expect((yield* search.search({ ...input, strategy: "compare" })).map((outcome) => outcome.provider)).toEqual([
        "high",
        "middle",
        "low",
      ])
    }),
  )

  it.effect("selects GitHub-kind searches only from a GitHub-capable provider", () =>
    Effect.gen(function* () {
      const github = makeProvider("github", 100, ["github"])
      const firecrawl = makeProvider("firecrawl", 80, ["web"])
      const search = WebSearch.make([firecrawl, github])
      expect((yield* search.search({ ...input, kind: "github" })).map((outcome) => outcome.provider)).toEqual([
        "github",
      ])
      expect(
        (yield* search.search({ ...input, kind: "github", strategy: "compare" })).map((outcome) => outcome.provider),
      ).toEqual(["github"])
      const unavailable = yield* Effect.flip(WebSearch.make([firecrawl]).search({ ...input, kind: "github" }))
      expect(unavailable.message).toContain("No configured web search provider supports 'github'")
    }),
  )

  it.effect("refuses at call time when no provider is configured", () =>
    Effect.gen(function* () {
      const unconfigured = yield* Effect.flip(WebSearch.make([]).search(input))
      expect(unconfigured._tag).toBe("WebSearchSelectionError")
      expect(unconfigured.message).toContain("No configured web search provider supports 'web' searches")
    }),
  )

  it.effect("reports partial failures and fails when every automatically selected provider fails", () =>
    Effect.gen(function* () {
      const failed = makeProvider("failed", 2, ["web"], () =>
        Effect.fail(WebSearchResult.ProviderFailure.make({ provider: "failed", kind: "timeout", message: "late" })),
      )
      const search = WebSearch.make([makeProvider("ok", 1), failed])
      const partial = yield* search.search({ ...input, strategy: "compare" })
      expect(partial.map((outcome) => outcome.provider)).toEqual(["failed", "ok"])
      expect(partial[0]?.error?.kind).toBe("timeout")
      const all = yield* Effect.flip(WebSearch.make([failed]).search(input))
      expect(all._tag).toBe("WebSearchExecutionError")
      const incapable = yield* Effect.flip(search.search({ ...input, kind: "code" }))
      expect(incapable.message).toContain("No configured web search provider supports 'code'")
    }),
  )

  it.effect("retries one transient transport failure but not permanent or rate-limited failures", () =>
    Effect.gen(function* () {
      let transientAttempts = 0
      const attemptTimes: Array<number> = []
      const transient = makeProvider("transient", 1, ["web"], () =>
        Effect.gen(function* () {
          attemptTimes.push(yield* Clock.currentTimeMillis)
          transientAttempts += 1
          return transientAttempts === 1
            ? yield* WebSearchResult.ProviderFailure.make({
                provider: "transient",
                kind: "transport",
                message: "reset",
              })
            : { results: [result] }
        }),
      )
      const search = WebSearch.make([transient])
      const fiber = yield* Effect.forkChild(search.search(input))
      yield* TestClock.adjust("200 millis")
      expect((yield* Fiber.join(fiber))[0]?.results).toEqual([result])
      expect(transientAttempts).toBe(2)
      expect(attemptTimes[1]! - attemptTimes[0]!).toBe(200)

      for (const kind of ["authentication", "rate-limit", "response"] as const) {
        let attempts = 0
        const provider = makeProvider(kind, 1, ["web"], () => {
          attempts += 1
          return Effect.fail(WebSearchResult.ProviderFailure.make({ provider: kind, kind, message: kind }))
        })
        yield* Effect.flip(WebSearch.make([provider]).search(input))
        expect(attempts).toBe(1)
      }
    }),
  )
})

describe("WebSearch HTTP providers", () => {
  it.effect("posts the Parallel request and normalizes its response", () => {
    const captured: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function* () {
      const parallel = yield* WebSearchProviderImpl.parallel({
        apiKey: Redacted.make("parallel"),
        baseUrl: "https://parallel.test",
      })
      const outcome = yield* parallel.search({ ...input, kind: "web", strategy: "auto" })
      expect(captured[0]?.method).toBe("POST")
      expect(captured[0]?.url).toBe("https://parallel.test/v1/search")
      expect(captured[0]?.headers["x-api-key"]).toBe("parallel")
      expect(body(captured[0]!)).toMatchObject({
        objective: input.objective,
        search_queries: input.searchQueries,
        mode: "advanced",
        max_chars_total: 40_000,
      })
      expect(outcome.results?.[0]).toMatchObject({
        url: "https://parallel.test/result",
        title: "Result",
        publishedAt: null,
        excerpts: ["excerpt"],
      })
    }).pipe(
      provide(
        clientLayer((request) => {
          captured.push(request)
          return response(request, {
            search_id: "search-1",
            session_id: "session-1",
            results: [{ url: "https://parallel.test/result", title: "Result", excerpts: ["excerpt"] }],
          })
        }),
      ),
    )
  })

  it.effect("accepts the official nullable Parallel title and publish date with usage and warnings", () =>
    Effect.gen(function* () {
      const parallel = yield* WebSearchProviderImpl.parallel({
        apiKey: Redacted.make("parallel"),
        baseUrl: "https://parallel.test",
      })
      const outcome = yield* parallel.search({ ...input, kind: "web", strategy: "auto" })
      expect(outcome.results?.[0]).toMatchObject({
        url: "https://parallel.test/result",
        title: null,
        publishedAt: null,
        excerpts: ["excerpt"],
      })
    }).pipe(
      provide(
        clientLayer((request) =>
          response(request, {
            search_id: "search-1",
            session_id: "session-1",
            results: [{ url: "https://parallel.test/result", title: null, publish_date: null, excerpts: ["excerpt"] }],
            usage: [{ name: "search", count: 1 }],
            warnings: [{ type: "warning", message: "note" }],
          }),
        ),
      ),
    ),
  )

  it.effect("accepts a Parallel result without title or publish date", () =>
    Effect.gen(function* () {
      const parallel = yield* WebSearchProviderImpl.parallel({
        apiKey: Redacted.make("parallel"),
        baseUrl: "https://parallel.test",
      })
      const outcome = yield* parallel.search({ ...input, kind: "web", strategy: "auto" })
      expect(outcome.results?.[0]).toMatchObject({
        url: "https://parallel.test/result",
        title: null,
        publishedAt: null,
        excerpts: ["excerpt"],
      })
    }).pipe(
      provide(
        clientLayer((request) =>
          response(request, {
            search_id: "search-1",
            session_id: "session-1",
            results: [{ url: "https://parallel.test/result", excerpts: ["excerpt"] }],
          }),
        ),
      ),
    ),
  )

  it.effect("builds and normalizes Exa web and code requests", () => {
    const captured: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function* () {
      const exa = yield* WebSearchProviderImpl.exa({ apiKey: Redacted.make("exa"), baseUrl: "https://exa.test" })
      expect([...exa.capabilities]).toEqual(["web", "code"])
      const webResult = yield* exa.search({ ...input, kind: "web", strategy: "auto" })
      const codeResult = yield* exa.search({ ...input, kind: "code", strategy: "auto" })
      expect(captured.map(({ url }) => url)).toEqual(["https://exa.test/search", "https://exa.test/context"])
      expect(body(captured[0]!)).toMatchObject({ type: "fast", contents: { highlights: true } })
      expect(body(captured[1]!)).toMatchObject({ tokensNum: "dynamic" })
      expect(webResult.results?.[0]).toMatchObject({ url: "https://exa.test/result", excerpts: ["highlight"] })
      expect(codeResult.content).toBe("formatted code context")
    }).pipe(
      provide(
        clientLayer((httpRequest) => {
          captured.push(httpRequest)
          return httpRequest.url.endsWith("/context")
            ? response(httpRequest, { response: "formatted code context" })
            : response(httpRequest, {
                results: [{ url: "https://exa.test/result", title: "Result", highlights: ["highlight"] }],
              })
        }),
      ),
    )
  })

  it.effect("builds Firecrawl web and GitHub REST requests without treating Firecrawl as GitHub search", () => {
    const captured: Array<HttpClientRequest.HttpClientRequest> = []
    return Effect.gen(function* () {
      const firecrawl = yield* WebSearchProviderImpl.firecrawl({
        apiKey: Redacted.make("fire"),
        baseUrl: "https://fire.test",
      })
      const github = yield* WebSearchProviderImpl.github({
        apiKey: Redacted.make("github"),
        baseUrl: "https://github.test",
      })
      expect([...firecrawl.capabilities]).toEqual(["web"])
      const fireResult = yield* firecrawl.search({ ...input, kind: "web", strategy: "auto" })
      const githubResult = yield* github.search({
        ...input,
        kind: "github",
        strategy: "auto",
        githubSearchType: "commits",
      })
      expect(body(captured[0]!)).not.toHaveProperty("categories")
      expect(captured[1]?.url).toContain("/search/commits?q=")
      expect(captured[1]?.headers["x-github-api-version"]).toBe("2022-11-28")
      expect(fireResult.results?.[0]?.excerpts).toEqual(["repository description"])
      expect(githubResult.results?.[0]?.excerpts).toEqual(["fragment", "commit body"])
    }).pipe(
      provide(
        clientLayer((httpRequest) => {
          captured.push(httpRequest)
          return httpRequest.url.includes("fire.test")
            ? response(httpRequest, { data: { web: [{ url: "https://repo", description: "repository description" }] } })
            : response(httpRequest, {
                items: [
                  {
                    html_url: "https://github.test/commit",
                    text_matches: [{ fragments: ["fragment"] }],
                    body: "commit body",
                  },
                ],
              })
        }),
      ),
    )
  })

  it.effect("normalizes authentication, rate-limit, and malformed response failures", () =>
    Effect.gen(function* () {
      const missing = yield* WebSearchProviderImpl.parallel({})
      expect((yield* Effect.flip(missing.search({ ...input, kind: "web", strategy: "auto" }))).kind).toBe(
        "authentication",
      )
      const limited = yield* WebSearchProviderImpl.github({
        apiKey: Redacted.make("key"),
        baseUrl: "https://github.test",
      })
      expect((yield* Effect.flip(limited.search({ ...input, kind: "github", strategy: "auto" }))).kind).toBe(
        "rate-limit",
      )
    }).pipe(
      provide(
        clientLayer((httpRequest) =>
          response(httpRequest, { message: "limit" }, 403, { "x-ratelimit-remaining": "0" }),
        ),
      ),
    ),
  )
})
