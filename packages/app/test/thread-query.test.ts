import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as Turn from "@rika/persistence/turn"
import { Effect, Layer, Schema, Stream } from "effect"
import { ThreadQuery, ThreadToolHandlers } from "../src"
import { ThreadTools } from "@rika/tools"
import { provideLayer } from "./layer"

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
  executionRoute: Turn.testExecutionRoute(),
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
})

const queryWith = (threads: ReadonlyArray<Thread.Thread>, turns: ReadonlyArray<Turn.Turn>) =>
  ThreadQuery.layer.pipe(
    Layer.provide(Layer.merge(ThreadRepository.memoryLayer(threads), TurnRepository.memoryLayer(turns))),
  )

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
        limit: 100,
      })
      expect(found.text).toContain('"id":"one"')
      expect(found.text).not.toContain('"id":"two"')
      expect(found.truncated).toBe(false)
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("requires explicit archived access and reports missing threads", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      expect((yield* query.find({ query: "Old" })).text).toBe("")
      expect((yield* query.find({ query: "Old", includeArchived: true })).text).toContain('"id":"two"')
      expect((yield* Effect.flip(query.read({ threadId: "two" })))._tag).toBe("ArchivedThreadError")
      expect((yield* Effect.flip(query.read({ threadId: "missing" })))._tag).toBe("ThreadNotFoundError")
      expect((yield* query.read({ threadId: "two", includeArchived: true })).text).toContain("# Old work")
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("reads and truncates deterministic transcripts", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const full = yield* query.read({ threadId: "one" })
      const bounded = yield* query.read({ threadId: "one", maxChars: 20 })
      expect(full.text).toContain("User: please fix auth")
      expect(bounded.text).toHaveLength(20)
      expect(bounded.truncated).toBe(true)
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("routes deterministic model tool calls through the product port", () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadTools.toolkit
      const chunks = yield* toolkit
        .handle("read_thread", { threadId: "one", maxChars: 200 })
        .pipe(Effect.flatMap(Stream.runCollect))
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([...chunks])).toContain("please fix auth")
    }).pipe(provideLayer(ThreadToolHandlers.handlerLayer.pipe(Layer.provide(queryLayer)))),
  )

  it.effect("maps query failures through both tool handlers", () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadTools.toolkit
      const find = yield* toolkit.handle("find_thread", { query: "x" }).pipe(Effect.flatMap(Stream.runCollect))
      const read = yield* toolkit.handle("read_thread", { threadId: "x" }).pipe(Effect.flatMap(Stream.runCollect))
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([...find])).toContain("find failed")
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([...read])).toContain("ThreadNotFoundError")
    }).pipe(
      provideLayer(
        ThreadToolHandlers.handlerLayer.pipe(
          Layer.provide(
            ThreadQuery.testLayer({
              find: () => Effect.fail(ThreadQuery.QueryError.make({ message: "find failed" })),
              read: () => Effect.fail(ThreadQuery.ThreadNotFoundError.make({ threadId: "x" })),
            }),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects invalid filters, dates, identifiers, and bounds", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      for (const input of [
        { query: "unknown:value" },
        { query: "label:" },
        { query: "after:nope" },
        { query: "before:2026-02-30" },
        { query: "", limit: 0 },
        { query: "", limit: 101 },
        { query: "", limit: 1.5 },
      ]) {
        const failure = yield* Effect.flip(query.find(input))
        expect(failure._tag).toBe("ThreadQueryError")
      }
      for (const input of [
        { threadId: "" },
        { threadId: "   " },
        { threadId: "one", maxTurns: 0 },
        { threadId: "one", maxTurns: 201 },
        { threadId: "one", maxTurns: 1.5 },
        { threadId: "one", maxChars: 0 },
        { threadId: "one", maxChars: 40_001 },
        { threadId: "one", maxChars: 1.5 },
      ]) {
        const failure = yield* Effect.flip(query.read(input))
        expect(failure._tag).toBe("ThreadQueryError")
      }
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("applies workspace aliases and date boundaries", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      expect((yield* query.find({ query: "workspace:ACME after:2026-01-10 before:2026-01-11" })).text).toContain(
        '"id":"one"',
      )
      expect((yield* query.find({ query: "after:2026-01-11" })).text).toBe("")
      const limited = yield* query.read({ threadId: "one", maxTurns: 200, maxChars: 40_000 })
      expect(limited.truncated).toBe(false)
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("reports result and Turn truncation independently of text truncation", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const found = yield* query.find({ query: "", limit: 1, includeArchived: true })
      const read = yield* query.read({ threadId: "one", maxTurns: 1, maxChars: 40_000 })
      expect(found.text.split("\n")).toHaveLength(1)
      expect(found.truncated).toBe(true)
      expect(read.text).toContain("User: first")
      expect(read.text).not.toContain("User: second")
      expect(read.truncated).toBe(true)
    }).pipe(
      provideLayer(
        queryWith(
          [thread("one", "Ordered"), thread("two", "Second")],
          [turn("turn-1", "one", "first"), { ...turn("turn-2", "one", "second"), createdAt: 2 }],
        ),
      ),
    ),
  )

  it.effect("preserves repository source order when rendering Turns", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const read = yield* query.read({ threadId: "one" })
      expect(read.text.indexOf("User: inserted first")).toBeLessThan(read.text.indexOf("User: inserted second"))
    }).pipe(
      provideLayer(
        queryWith(
          [thread("one", "Ordered")],
          [turn("turn-z", "one", "inserted first"), turn("turn-a", "one", "inserted second")],
        ),
      ),
    ),
  )

  it.effect("maps thread listing, lookup, and turn listing repository failures", () =>
    Effect.gen(function* () {
      const threadFailure = ThreadRepository.RepositoryError.make({ message: "thread storage unavailable" })
      const turnFailure = TurnRepository.RepositoryError.make({ message: "turn storage unavailable" })
      const baseThreads = yield* ThreadRepository.makeMemory([thread("one", "Failure test")])
      const baseTurns = yield* TurnRepository.makeMemory()
      const run = (threads: ThreadRepository.Interface, turns: TurnRepository.Interface) =>
        Effect.gen(function* () {
          const query = yield* ThreadQuery.Service
          return query
        }).pipe(
          provideLayer(
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
