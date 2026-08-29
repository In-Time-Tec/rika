import * as ThreadQuery from "@rika/product/thread-query-service"
import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Layer } from "effect"
import { provideLayer } from "../turn/postgres/repository-layer.harness"
import { Fixtures, threadRecordsFixture, turnRecordsFixture } from "./process-local-index.support"
import { workspace, storedThread, storedTurn } from "./process-local-index.fixture"
import { queryLayer } from "./process-local-index.harness"

describe("ThreadQuery", () => {
  it.effect("finds metadata and file content only in the current workspace", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const metadata = yield* query.find({ query: "auth" })
      const file = yield* query.find({ query: "file:src/auth.ts" })
      expect(metadata).toMatchObject({ schemaVersion: 1, threads: [{ threadId: "one", title: "Fix auth" }] })
      expect(file.threads[0]?.summary).toBe("src/auth.ts")
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("reports observable Thread execution state", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const found = yield* query.find({ query: "states" })
      expect(found.threads.map(({ state }) => state)).toEqual(["running", "running", "queued", "error"])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("repairs search from current Thread metadata and messages without crossing workspaces", () =>
    Effect.gen(function* () {
      const local = { ...storedThread, id: Fixtures.Thread.ThreadId.make("fresh-local"), title: "Initial title" }
      const foreign = {
        ...storedThread,
        id: Fixtures.Thread.ThreadId.make("fresh-foreign"),
        workspace: "/other/workspace",
        title: "renamed needle",
      }
      const localTurn = {
        ...storedTurn,
        id: Fixtures.Turn.TurnId.make("fresh-turn"),
        threadId: local.id,
        prompt: "initial",
      }
      const threadRepository = Context.get(
        yield* Layer.build(threadRecordsFixture([local, foreign])),
        Fixtures.ThreadRepository.Service,
      )
      const turns = Context.get(yield* Layer.build(turnRecordsFixture([localTurn])), Fixtures.TurnRepository.Service)
      const transcripts = Context.get(
        yield* Layer.build(Fixtures.TranscriptRepository.memoryLayer()),
        Fixtures.TranscriptRepository.Service,
      )
      const searches = yield* Fixtures.ThreadSearchRepository.make
      const dependencies = Layer.mergeAll(
        Layer.succeed(Fixtures.ThreadRepository.Service, threadRepository),
        Layer.succeed(Fixtures.TurnRepository.Service, turns),
        Layer.succeed(Fixtures.TranscriptRepository.Service, transcripts),
        Layer.succeed(Fixtures.ThreadSearchRepository.Service, searches),
      )
      const layer = Layer.merge(
        ThreadQuery.Runtime.layerForWorkspace(workspace).pipe(Layer.provide(dependencies)),
        dependencies,
      )

      yield* Effect.gen(function* () {
        const query = yield* ThreadQuery.Service
        expect((yield* query.find({ query: "renamed needle" })).threads).toEqual([])
        yield* threadRepository.rename(local.id, "renamed needle", 3)
        expect((yield* query.find({ query: "renamed needle" })).threads.map((thread) => thread.threadId)).toEqual([
          "fresh-local",
        ])
        yield* turns.copy(
          {
            ...localTurn,
            id: Fixtures.Turn.TurnId.make("fresh-message"),
            prompt: "message needle",
            createdAt: 4,
            updatedAt: 4,
          },
          10,
        )
        expect((yield* query.find({ query: "message needle" })).threads.map((thread) => thread.threadId)).toEqual([
          "fresh-local",
        ])
        yield* threadRepository.setArchived(local.id, true, 5)
        expect((yield* query.find({ query: "renamed needle" })).threads).toEqual([])
        expect(
          (yield* query.find({ query: "renamed needle", includeArchived: true })).threads.map(
            (thread) => thread.threadId,
          ),
        ).toEqual(["fresh-local"])
      }).pipe(provideLayer(layer))
    }),
  )

  it.effect("returns structured recent output", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const recent = yield* query.read({ threadId: "one", selector: { _tag: "recent" } })
      expect(recent).toMatchObject({ schemaVersion: 1, selector: { _tag: "recent" }, items: [{ author: "human" }] })
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("represents unavailable subtrees", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const child = yield* query.read({
        threadId: "one",
        selector: { _tag: "subtree", subagentId: "missing" },
      })
      expect(child.omissions[0]).toMatchObject({ reason: "unavailableSubagent", continuation: { _tag: "subtree" } })
    }).pipe(provideLayer(queryLayer)),
  )
})
