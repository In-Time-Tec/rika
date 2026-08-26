import * as WebSearchInput from "../../src/web-research/search/input"
import * as WebSearchResult from "../../src/web-research/search/result"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as Runtime from "@rika/coding-tools/coding-tool-runtime"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import * as WebSearchErrors from "../../src/web-research/search/errors"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { provide } from "../support/layer"
import { bytesOf, TestEnvironment } from "../support/runtime-environment"

describe("Runtime web tools", () => {
  it.effect("times out safe calls with a known outcome and an actionable retry", () => {
    const environment = TestEnvironment.make("success", () => Effect.never)
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(
        runtime.run({ _tag: "WebSearch", objective: "wait", searchQueries: ["wait"] }),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("30 seconds")
      const failure = yield* Effect.flip(Fiber.join(call))
      expect(failure).toMatchObject({
        category: "timeout",
        outcome: "known",
        recovery: "later",
      })
      expect(failure.message).toContain("after 30000ms")
      expect(failure.message).toContain("did not change state")
    }).pipe(provide(environment.runtime))
  })

  it.effect("keeps a provider retry inside the original tool deadline", () => {
    let attempts = 0
    const search = WebSearch.make([
      {
        id: "fixture",
        priority: 1,
        capabilities: new Set<WebSearchInput.Capability>(["web"]),
        search: () => {
          attempts += 1
          return attempts === 1
            ? Effect.fail(
                WebSearchResult.ProviderFailure.make({ provider: "fixture", kind: "transport", message: "reset" }),
              )
            : Effect.never
        },
      },
    ])
    const environment = TestEnvironment.make("success", search.search)
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const call = yield* Effect.forkChild(
        runtime.run({ _tag: "WebSearch", objective: "wait", searchQueries: ["wait"] }),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust("30 seconds")
      const failure = yield* Effect.flip(Fiber.join(call))
      expect(attempts).toBe(2)
      expect(failure).toMatchObject({ category: "timeout", outcome: "known", recovery: "later" })
      expect(failure.message).toContain("after 30000ms")
    }).pipe(provide(environment.runtime))
  })

  it.effect("interrupts cancelled calls and releases call-scoped resources", () =>
    Effect.gen(function* () {
      const released = yield* Ref.make(false)
      const environment = TestEnvironment.make("success", () =>
        Effect.scoped(
          Effect.acquireRelease(Effect.void, () => Ref.set(released, true)).pipe(Effect.andThen(Effect.never)),
        ),
      )
      yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        const call = yield* Effect.forkChild(
          runtime.run({ _tag: "WebSearch", objective: "wait", searchQueries: ["wait"] }),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(call)
        expect(yield* Ref.get(released)).toBe(true)
      }).pipe(provide(environment.runtime))
    }),
  )

  it.effect("returns bounded provider-neutral web search outcomes", () => {
    const environment = TestEnvironment.make()
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const result = yield* runtime.run({
        _tag: "WebSearch",
        objective: "Find current documentation",
        searchQueries: ["current documentation"],
      })
      expect(yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(result.text)).toEqual([
        {
          provider: "fixture",
          results: [{ url: "https://example.com", title: "Example", publishedAt: null, excerpts: ["result"] }],
        },
      ])
      expect(result.truncated).toBe(false)
    }).pipe(provide(environment.runtime))
  })

  it.effect("bounds search serialization and extracted page text at the runtime boundary", () => {
    const environment = TestEnvironment.make(
      "success",
      () =>
        Effect.succeed([
          {
            provider: "fixture",
            results: [{ url: "https://example.com", title: null, publishedAt: null, excerpts: ["s".repeat(40_001)] }],
          },
        ]),
      () => Effect.succeed("p".repeat(40_001)),
    )
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const search = yield* runtime.run({
        _tag: "WebSearch",
        objective: "Find bounded text",
        searchQueries: ["bounded text"],
      })
      const page = yield* runtime.run({ _tag: "ReadWebPage", url: "https://example.com" })
      expect(search).toMatchObject({ truncated: true })
      expect(bytesOf(search.text)).toBe(16_384)
      expect(search.text).toContain("[truncated: kept first")
      expect(bytesOf(page.text)).toBe(16_384)
      expect(page.text).toContain("[truncated: kept first")
      expect(page.text).toContain("request focused excerpts")
      expect(page.text.match(/\[truncated:/g)).toHaveLength(1)
      expect(page.truncated).toBe(true)
    }).pipe(provide(environment.runtime))
  })

  it.effect("routes status, web page, and media requests and reads outside the workspace", () => {
    const environment = TestEnvironment.make()
    environment.files.set("/outside", "outside content")
    return Effect.gen(function* () {
      const runtime = yield* Runtime.Service
      const status = yield* Effect.flip(
        runtime.run({ _tag: "ShellCommandStatus", processId: "missing", waitMillis: -1 }),
      )
      const pageDefault = yield* runtime.run({ _tag: "ReadWebPage", url: "https://example.com" })
      const pageOptions = yield* runtime.run({
        _tag: "ReadWebPage",
        url: "https://example.com",
        objective: "docs",
        fullContent: true,
        forceRefetch: true,
      })
      const media = yield* Effect.flip(runtime.run({ _tag: "ViewMedia", path: "missing.png" }))
      const outside = yield* runtime.run({ _tag: "Read", path: "../outside" })
      expect(status).toMatchObject({ _tag: "ToolError", tool: "shell_command_status" })
      expect(pageDefault.text).toBe("page")
      expect(pageOptions.text).toBe("page")
      expect(media.tool).toBe("view_media")
      expect(outside.text).toContain("outside content")
    }).pipe(provide(environment.runtime))
  })

  it.effect("classifies unavailable and rate-limited web dependencies with recovery guidance", () =>
    Effect.gen(function* () {
      const unavailable = TestEnvironment.make("success", () =>
        Effect.fail(
          WebSearchErrors.SelectionError.make({ message: "No configured web search provider supports 'web' searches" }),
        ),
      )
      const rateLimited = TestEnvironment.make("success", () =>
        Effect.fail(
          WebSearchErrors.ExecutionError.make({
            message: "All selected web search providers failed",
            outcomes: [
              {
                provider: "fixture",
                error: WebSearchResult.ProviderFailure.make({
                  provider: "fixture",
                  kind: "rate-limit",
                  message: "limited",
                }),
              },
            ],
          }),
        ),
      )
      const unconfiguredPage = TestEnvironment.make(
        "success",
        () => Effect.succeed([]),
        () => Effect.fail(ReadWebPage.HttpError.make({ message: "PARALLEL_API_KEY is not configured" })),
      )
      const request = { _tag: "WebSearch" as const, objective: "docs", searchQueries: ["docs"] }
      const pageRequest = { _tag: "ReadWebPage" as const, url: "https://example.com" }
      const unavailableFailure = yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        return yield* Effect.flip(runtime.run(request))
      }).pipe(provide(unavailable.runtime))
      const rateFailure = yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        return yield* Effect.flip(runtime.run(request))
      }).pipe(provide(rateLimited.runtime))
      const pageFailure = yield* Effect.gen(function* () {
        const runtime = yield* Runtime.Service
        return yield* Effect.flip(runtime.run(pageRequest))
      }).pipe(provide(unconfiguredPage.runtime))

      expect(unavailableFailure).toMatchObject({
        category: "dependency_unavailable",
        recovery: "after_change",
        outcome: "known",
      })
      expect(unavailableFailure.message).toContain("No configured web search provider")
      expect(rateFailure).toMatchObject({ category: "rate_limited", recovery: "later", outcome: "known" })
      expect(rateFailure.message).toContain("rate limited")
      expect(pageFailure).toMatchObject({
        category: "dependency_unavailable",
        recovery: "after_change",
        outcome: "known",
      })
      expect(pageFailure.message).toContain("PARALLEL_API_KEY is not configured")
    }),
  )
})
