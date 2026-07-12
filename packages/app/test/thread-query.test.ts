import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import { Effect, Layer, Stream } from "effect"
import { ThreadQuery, ThreadToolHandlers } from "../src"
import { ThreadTools } from "@rika/tools"

const thread = (
  id: string,
  title: string,
  options: { archived?: boolean; labels?: ReadonlyArray<string>; workspace?: string } = {},
) => ({
  id: Thread.ThreadId.make(id),
  workspace: options.workspace ?? "/work/acme",
  title,
  labels: [...(options.labels ?? [])],
  pinned: false,
  archived: options.archived ?? false,
  createdAt: Date.parse("2026-01-10"),
  updatedAt: Date.parse("2026-01-10"),
})

const turn = (id: string, threadId: string, prompt: string): Turn.Turn => ({
  id: Turn.TurnId.make(id),
  threadId: Thread.ThreadId.make(threadId),
  prompt,
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
})

const queryLayer = ThreadQuery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ThreadRepository.memoryLayer([
        thread("one", "Fix auth", { labels: ["bug", "author:alice", "ref:main", "file:src/auth.ts"] }),
        thread("two", "Old work", { archived: true }),
        thread("three", "Other repo", { workspace: "/work/other" }),
      ]),
      TurnRepository.memoryLayer([turn("turn-1", "one", "please fix auth")]),
    ),
  ),
)

describe("ThreadQuery", () => {
  it.effect("parses and applies bounded metadata terms while excluding archived threads", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const found = yield* query.find({
        query: "auth repo:acme label:bug author:alice ref:main file:src/auth.ts after:2026-01-01 before:2026-02-01",
        limit: 999,
      })
      expect(found.text).toContain('"id":"one"')
      expect(found.text).not.toContain('"id":"two"')
      expect(found.truncated).toBe(false)
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect("requires explicit archived access and reports missing threads", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      expect((yield* Effect.flip(query.read({ threadId: "two" })))._tag).toBe("ArchivedThreadError")
      expect((yield* Effect.flip(query.read({ threadId: "missing" })))._tag).toBe("ThreadNotFoundError")
      expect((yield* query.read({ threadId: "two", includeArchived: true })).text).toContain("# Old work")
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect("reads and truncates deterministic transcripts", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const full = yield* query.read({ threadId: "one" })
      const bounded = yield* query.read({ threadId: "one", maxChars: 20 })
      expect(full.text).toContain("User: please fix auth")
      expect(bounded.text).toHaveLength(20)
      expect(bounded.truncated).toBe(true)
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect("routes deterministic model tool calls through the product port", () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadTools.toolkit
      const chunks = yield* toolkit
        .handle("read_thread", { threadId: "one", maxChars: 200 })
        .pipe(Effect.flatMap(Stream.runCollect))
      expect(JSON.stringify([...chunks])).toContain("please fix auth")
    }).pipe(Effect.provide(ThreadToolHandlers.handlerLayer.pipe(Layer.provide(queryLayer)))),
  )

  it.effect("maps query failures through both tool handlers", () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadTools.toolkit
      const find = yield* toolkit.handle("find_thread", { query: "x" }).pipe(Effect.flatMap(Stream.runCollect))
      const read = yield* toolkit.handle("read_thread", { threadId: "x" }).pipe(Effect.flatMap(Stream.runCollect))
      expect(JSON.stringify([...find])).toContain("find failed")
      expect(JSON.stringify([...read])).toContain("ThreadNotFoundError")
    }).pipe(
      Effect.provide(
        ThreadToolHandlers.handlerLayer.pipe(
          Layer.provide(
            ThreadQuery.testLayer({
              find: () => Effect.fail(new ThreadQuery.QueryError({ message: "find failed" })),
              read: () => Effect.fail(new ThreadQuery.ThreadNotFoundError({ threadId: "x" })),
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("covers invalid dates, unmatched metadata, limits, and empty text queries", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const invalid = yield* query.find({ query: "after:nope before:nope", limit: 0, includeArchived: true })
      const unmatched = yield* query.find({ query: "label:nope", limit: -1 })
      const empty = yield* query.find({ query: "", limit: 1 })
      expect(invalid.text).toBe("")
      expect(unmatched.text).toBe("")
      expect(empty.text).toContain('"id":"one"')
      expect((yield* query.read({ threadId: "one", maxTurns: 0, maxChars: 0 })).text).toHaveLength(1)
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect("applies workspace aliases, date boundaries, unknown terms, and turn limits", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      expect((yield* query.find({ query: "workspace:ACME after:2026-01-10 before:2026-01-11" })).text).toContain(
        '"id":"one"',
      )
      expect((yield* query.find({ query: "after:2026-01-11" })).text).toBe("")
      expect((yield* query.find({ query: "unknown:value" })).text).toBe("")
      const limited = yield* query.read({ threadId: "one", maxTurns: 999, maxChars: 99_999 })
      expect(limited.truncated).toBe(false)
    }).pipe(Effect.provide(queryLayer)),
  )

  it.effect("maps thread listing, lookup, and turn listing repository failures", () =>
    Effect.gen(function* () {
      const threadFailure = new ThreadRepository.RepositoryError({ message: "thread storage unavailable" })
      const turnFailure = new TurnRepository.RepositoryError({ message: "turn storage unavailable" })
      const baseThreads = yield* ThreadRepository.makeMemory([thread("one", "Failure test")])
      const baseTurns = yield* TurnRepository.makeMemory()
      const run = (threads: ThreadRepository.Interface, turns: TurnRepository.Interface) =>
        Effect.gen(function* () {
          const query = yield* ThreadQuery.Service
          return query
        }).pipe(
          Effect.provide(
            ThreadQuery.layer.pipe(
              Layer.provide(
                Layer.merge(
                  Layer.succeed(ThreadRepository.Service, threads),
                  Layer.succeed(TurnRepository.Service, turns),
                ),
              ),
            ),
          ),
        )
      const listing = yield* run({ ...baseThreads, list: () => Effect.fail(threadFailure) }, baseTurns)
      const lookup = yield* run({ ...baseThreads, get: () => Effect.fail(threadFailure) }, baseTurns)
      const turns = yield* run(baseThreads, { ...baseTurns, list: () => Effect.fail(turnFailure) })
      expect((yield* Effect.flip(listing.find({ query: "" }))).message).toBe("thread storage unavailable")
      expect((yield* Effect.flip(lookup.read({ threadId: "one" }))).message).toBe("thread storage unavailable")
      expect((yield* Effect.flip(turns.read({ threadId: "one" }))).message).toBe("turn storage unavailable")
    }),
  )
})
