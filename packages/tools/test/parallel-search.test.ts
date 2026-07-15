import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ParallelSearch } from "../src"
import { provide } from "./test-layer"

const response = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(Schema.encodeSync(Schema.UnknownFromJsonString)(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const clientLayer = (run: (request: HttpClientRequest.HttpClientRequest) => HttpClientResponse.HttpClientResponse) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(run(request))),
  )

describe("ParallelSearch", () => {
  it.effect("posts the documented Parallel request and normalizes results", () => {
    let captured: HttpClientRequest.HttpClientRequest | undefined
    return Effect.gen(function* () {
      const search = yield* ParallelSearch.Service
      const results = yield* search.search({
        objective: "Find current Parallel documentation",
        searchQueries: ["Parallel search documentation", "Parallel API reference"],
      })
      expect(captured?.method).toBe("POST")
      expect(captured?.url).toBe("https://parallel.test/v1/search")
      expect(captured?.headers["x-api-key"]).toBe("secret")
      if (captured?.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON request")
      expect(
        yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(new TextDecoder().decode(captured.body.body)),
      ).toEqual({
        objective: "Find current Parallel documentation",
        search_queries: ["Parallel search documentation", "Parallel API reference"],
        mode: "advanced",
        max_chars_total: 40_000,
      })
      expect(results).toEqual([
        {
          url: "https://docs.parallel.ai",
          title: "Parallel Docs",
          publishDate: null,
          excerpts: ["Current documentation"],
        },
      ])
    }).pipe(
      provide(
        ParallelSearch.layer({ apiKey: Redacted.make("secret"), baseUrl: "https://parallel.test" }).pipe(
          Layer.provide(
            clientLayer((request) => {
              captured = request
              return response(request, {
                search_id: "search-1",
                session_id: "session-1",
                results: [
                  {
                    url: "https://docs.parallel.ai",
                    title: "Parallel Docs",
                    publish_date: null,
                    excerpts: ["Current documentation"],
                  },
                ],
              })
            }),
          ),
        ),
      ),
    )
  })

  it.effect("fails clearly when the API key is absent", () =>
    Effect.gen(function* () {
      const search = yield* ParallelSearch.Service
      const error = yield* Effect.flip(search.search({ objective: "Current docs", searchQueries: ["current docs"] }))
      expect(error.message).toContain("PARALLEL_API_KEY")
    }).pipe(
      provide(
        ParallelSearch.layer({}).pipe(Layer.provide(clientLayer((request) => response(request, { unused: true })))),
      ),
    ),
  )

  it.effect.each([
    [500, { error: "unavailable" }],
    [200, { invalid: true }],
  ] as const)("maps status and response failures for status %s", ([status, body]) =>
    Effect.gen(function* () {
      const search = yield* ParallelSearch.Service
      const error = yield* Effect.flip(search.search({ objective: "Current docs", searchQueries: ["current docs"] }))
      expect(error._tag).toBe("ParallelSearchError")
    }).pipe(
      provide(
        ParallelSearch.layer({ apiKey: Redacted.make("secret") }).pipe(
          Layer.provide(clientLayer((request) => response(request, body, status))),
        ),
      ),
    ),
  )
})
