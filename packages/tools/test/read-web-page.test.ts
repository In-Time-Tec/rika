import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ReadWebPage } from "../src"
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

const apiResponse = (overrides: Record<string, unknown> = {}) => ({
  extract_id: "extract-1",
  session_id: "session-1",
  results: [
    {
      url: "https://example.com/docs",
      title: "Docs",
      publish_date: null,
      excerpts: ["First excerpt", "Second excerpt"],
      full_content: "# Complete page",
    },
  ],
  errors: [],
  ...overrides,
})

const run = (
  input: ReadWebPage.Input,
  handler: (request: HttpClientRequest.HttpClientRequest) => HttpClientResponse.HttpClientResponse,
  apiKey = Redacted.make("secret"),
) =>
  Effect.gen(function* () {
    const reader = yield* ReadWebPage.Service
    return yield* reader.read(input)
  }).pipe(
    provide(ReadWebPage.layer({ apiKey, baseUrl: "https://parallel.test" }).pipe(Layer.provide(clientLayer(handler)))),
  )

describe("ReadWebPage", () => {
  it.effect("posts the exact V1 request with API key and returns joined objective excerpts", () => {
    let captured: HttpClientRequest.HttpClientRequest | undefined
    return Effect.gen(function* () {
      const content = yield* run({ url: "https://example.com/docs", objective: "Find API details" }, (request) => {
        captured = request
        return response(request, apiResponse())
      })
      expect(captured?.method).toBe("POST")
      expect(captured?.url).toBe("https://parallel.test/v1/extract")
      expect(captured?.headers["x-api-key"]).toBe("secret")
      if (captured?.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON request")
      expect(
        yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(new TextDecoder().decode(captured.body.body)),
      ).toEqual({
        urls: ["https://example.com/docs"],
        objective: "Find API details",
        max_chars_total: 40_000,
      })
      expect(content).toBe("First excerpt\n\nSecond excerpt")
    })
  })

  it.effect("requests and returns full content", () =>
    Effect.gen(function* () {
      let body: unknown
      const content = yield* run({ url: "https://example.com/docs", fullContent: true }, (request) => {
        if (request.body._tag === "Uint8Array") body = JSON.parse(new TextDecoder().decode(request.body.body))
        return response(request, apiResponse())
      })
      expect(body).toEqual({
        urls: ["https://example.com/docs"],
        max_chars_total: 40_000,
        advanced_settings: { full_content: true },
      })
      expect(content).toBe("# Complete page")
    }),
  )

  it.effect("uses the V1 fetch policy for force refetch", () =>
    Effect.gen(function* () {
      let body: unknown
      yield* run({ url: "https://example.com/docs", forceRefetch: true }, (request) => {
        if (request.body._tag === "Uint8Array") body = JSON.parse(new TextDecoder().decode(request.body.body))
        return response(request, apiResponse())
      })
      expect(body).toEqual({
        urls: ["https://example.com/docs"],
        max_chars_total: 40_000,
        advanced_settings: { fetch_policy: { max_age_seconds: 600, disable_cache_fallback: true } },
      })
    }),
  )

  it.effect("uses the default API base URL", () => {
    let captured = ""
    return Effect.gen(function* () {
      const reader = yield* ReadWebPage.Service
      yield* reader.read({ url: "https://example.com" })
      expect(captured).toBe("https://api.parallel.ai/v1/extract")
    }).pipe(
      provide(
        ReadWebPage.layer({ apiKey: Redacted.make("secret") }).pipe(
          Layer.provide(
            clientLayer((request) => {
              captured = request.url
              return response(request, apiResponse())
            }),
          ),
        ),
      ),
    )
  })

  it.effect("fails clearly when the credential is missing", () =>
    Effect.gen(function* () {
      const reader = yield* ReadWebPage.Service
      const error = yield* Effect.flip(reader.read({ url: "https://example.com" }))
      expect(error._tag).toBe("ReadWebPageHttpError")
      expect(error.message).toContain("PARALLEL_API_KEY")
    }).pipe(
      provide(ReadWebPage.layer({}).pipe(Layer.provide(clientLayer((request) => response(request, apiResponse()))))),
    ),
  )

  it.effect.each([
    [500, { error: "unavailable" }],
    [200, { invalid: true }],
  ] as const)("maps API failures for status %s", ([status, body]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run({ url: "https://example.com" }, (request) => response(request, body, status)),
      )
      expect(error._tag).toBe("ReadWebPageHttpError")
    }),
  )

  it.effect("reports every per-URL extraction error without dropping details", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        run({ url: "https://example.com" }, (request) =>
          response(
            request,
            apiResponse({
              results: [],
              errors: [
                {
                  url: "https://example.com",
                  error_type: "fetch_error",
                  http_status_code: 503,
                  content: "Origin unavailable",
                },
                {
                  url: "https://example.org",
                  error_type: "robots_denied",
                  http_status_code: null,
                  content: "Blocked by robots",
                },
              ],
            }),
          ),
        ),
      )
      expect(error._tag).toBe("ReadWebPageContentError")
      expect(error.message).toContain("https://example.com: fetch_error (503): Origin unavailable")
      expect(error.message).toContain("https://example.org: robots_denied: Blocked by robots")
    }),
  )

  it.effect("rejects empty results and missing requested full content", () =>
    Effect.gen(function* () {
      const empty = yield* Effect.flip(
        run({ url: "https://example.com" }, (request) => response(request, apiResponse({ results: [] }))),
      )
      const missing = yield* Effect.flip(
        run({ url: "https://example.com", fullContent: true }, (request) =>
          response(request, apiResponse({ results: [{ ...apiResponse().results[0], full_content: null }] })),
        ),
      )
      expect(empty.message).toContain("returned no results")
      expect(missing.message).toContain("no full content")
    }),
  )

  it.effect.each(["not a url", "ftp://example.com", "https://user:pass@example.com"])(
    "validates URL %s before extraction",
    (url) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(run({ url }, (request) => response(request, apiResponse())))
        expect(error._tag).toBe("ReadWebPageContentError")
      }),
  )
})
