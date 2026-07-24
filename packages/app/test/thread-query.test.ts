import { describe, expect, it } from "@effect/vitest"
import * as ThreadRepository from "@rika/persistence/repository"
import * as ThreadInteractionRepository from "@rika/persistence/thread-interaction-repository"
import * as ThreadSearchRepository from "@rika/persistence/thread-search-repository"
import * as Thread from "@rika/persistence/thread"
import * as TurnRepository from "@rika/persistence/turn-repository"
import * as TranscriptRepository from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import { ThreadTools } from "@rika/tools"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ThreadQuery, ThreadToolHandlers } from "../src"
import { provideLayer } from "./layer"

const workspace = "/work/acme"
const storedThread: Thread.Thread = {
  id: Thread.ThreadId.make("one"),
  workspace,
  title: "Fix auth",
  labels: ["bug"],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 2,
}
const storedTurn: Turn.Turn = {
  id: Turn.TurnId.make("turn-1"),
  threadId: storedThread.id,
  prompt: "fix auth",
  executionRoute: Turn.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "completed",
  createdAt: 1,
  updatedAt: 2,
}
const relatedThread: Thread.Thread = {
  ...storedThread,
  id: Thread.ThreadId.make("two"),
  title: "Related work",
  createdAt: 3,
  updatedAt: 3,
}
const stateThreads = (["waiting", "running", "queued", "failed"] as const).map((status, index) => ({
  thread: {
    ...storedThread,
    id: Thread.ThreadId.make(`state-${status}`),
    title: status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
  turn: {
    ...storedTurn,
    id: Turn.TurnId.make(`turn-${status}`),
    threadId: Thread.ThreadId.make(`state-${status}`),
    status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
}))
const search = ThreadSearchRepository.Service.of({
  search: (input) =>
    Effect.sync(() => {
      let results: ThreadSearchRepository.SearchPage["results"] = []
      if (input.workspace === workspace && input.query === "states") {
        results = stateThreads.map(({ thread }) => ({
          schemaVersion: 2,
          threadId: thread.id,
          title: thread.title,
          workspace,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          archived: false,
          matchedBy: ["title"],
          snippets: [{ source: "title", text: thread.title }],
          omissionReasons: [],
        }))
      } else if (input.workspace === workspace && input.query.includes("auth")) {
        results = [
          {
            schemaVersion: 2,
            threadId: storedThread.id,
            title: storedThread.title,
            workspace,
            createdAt: 1,
            updatedAt: 2,
            archived: false,
            matchedBy: [input.query.includes("file:") ? "file" : "title"],
            snippets: [
              {
                source: input.query.includes("file:") ? "file" : "title",
                text: input.query.includes("file:") ? "src/auth.ts" : "Fix auth",
              },
            ],
            omissionReasons: [],
          },
        ]
      }
      return {
        schemaVersion: 2,
        results,
        nextCursor: undefined,
      }
    }),
  rebuildThread: () => Effect.void,
  removeThread: () => Effect.void,
})
const repositories = Layer.mergeAll(
  ThreadRepository.memoryLayer([storedThread, relatedThread, ...stateThreads.map(({ thread }) => thread)]),
  TurnRepository.memoryLayer([storedTurn, ...stateThreads.map(({ turn }) => turn)]),
  TranscriptRepository.memoryLayer,
  Layer.succeed(ThreadSearchRepository.Service, search),
  Layer.effect(
    ThreadInteractionRepository.Service,
    ThreadInteractionRepository.makeMemory({ threads: [storedThread, relatedThread], turns: [storedTurn] }),
  ),
)
const queryLayer = Layer.merge(ThreadQuery.layerForWorkspace(workspace).pipe(Layer.provide(repositories)), repositories)

describe("ThreadQuery", () => {
  it.effect("finds metadata and file content only in the current workspace", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const metadata = yield* query.find({ query: "auth" })
      const file = yield* query.find({ query: "file:src/auth.ts" })
      expect(metadata).toMatchObject({ schemaVersion: 2, threads: [{ threadId: "one", title: "Fix auth" }] })
      expect(file.threads[0]?.summary).toBe("src/auth.ts")
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("reports observable Thread execution state", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const found = yield* query.find({ query: "states" })
      expect(found.threads.map(({ state }) => state)).toEqual(["awaiting-approval", "running", "queued", "error"])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("repairs search from current Thread metadata and messages without crossing workspaces", () =>
    Effect.gen(function* () {
      const local = { ...storedThread, id: Thread.ThreadId.make("fresh-local"), title: "Initial title" }
      const foreign = {
        ...storedThread,
        id: Thread.ThreadId.make("fresh-foreign"),
        workspace: "/other/workspace",
        title: "renamed needle",
      }
      const localTurn = { ...storedTurn, id: Turn.TurnId.make("fresh-turn"), threadId: local.id, prompt: "initial" }
      const threadRepository = yield* ThreadRepository.makeMemory([local, foreign])
      const turns = yield* TurnRepository.makeMemory([localTurn])
      const transcripts = Context.get(
        yield* Layer.build(TranscriptRepository.memoryLayer),
        TranscriptRepository.Service,
      )
      const searches = yield* ThreadSearchRepository.makeMemory
      const interactions = yield* ThreadInteractionRepository.makeMemory({
        threads: [local, foreign],
        turns: [localTurn],
      })
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadRepository.Service, threadRepository),
        Layer.succeed(TurnRepository.Service, turns),
        Layer.succeed(TranscriptRepository.Service, transcripts),
        Layer.succeed(ThreadSearchRepository.Service, searches),
        Layer.succeed(ThreadInteractionRepository.Service, interactions),
      )
      const layer = Layer.merge(
        ThreadQuery.layerForWorkspace(workspace).pipe(Layer.provide(dependencies)),
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
            id: Turn.TurnId.make("fresh-message"),
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

  it.effect("returns structured recent output and legacy schema-versioned JSON", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const recent = yield* query.readStructured({ threadId: "one", selector: { _tag: "recent" } })
      const legacy = yield* query.read({ threadId: "one" })
      expect(recent).toMatchObject({ schemaVersion: 2, selector: { _tag: "recent" }, items: [{ author: "human" }] })
      expect(yield* Schema.decodeEffect(Schema.UnknownFromJsonString)(legacy.text)).toMatchObject({
        schemaVersion: 2,
        threadId: "one",
      })
      expect(legacy.text.length).toBeLessThanOrEqual(ThreadQuery.transcriptBudget)
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("represents unavailable subtrees and traverses related Threads", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const interactions = yield* ThreadInteractionRepository.Service
      yield* interactions.appendMessage({
        invocationDigest: "related",
        schemaInputDigest: "related",
        sourceThreadId: storedThread.id,
        sourceRootTurnId: storedTurn.id,
        now: 4,
        maximumDepth: 3,
        maximumAdmissions: 8,
        maximumWorkspaceActive: 8,
        queueCapacity: 4,
        turnId: Turn.TurnId.make("turn-2"),
        prompt: "continue",
        executionRoute: storedTurn.executionRoute,
        targetThreadId: relatedThread.id,
        resultDelivery: "manual",
        threadCreationDepth: 1,
      })
      const child = yield* query.readStructured({
        threadId: "one",
        selector: { _tag: "subtree", childExecutionId: "missing" },
      })
      const related = yield* query.readStructured({ threadId: "one", selector: { _tag: "related" } })
      expect(child.omissions[0]).toMatchObject({ reason: "unavailableChild", continuation: { _tag: "subtree" } })
      expect(related.relatedThreads).toEqual([
        expect.objectContaining({
          kind: "message",
          direction: "outgoing",
          threadId: "two",
          turnId: "turn-2",
          available: true,
        }),
      ])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("paginates tied incoming and outgoing Thread relationships without gaps", () =>
    Effect.gen(function* () {
      const query = yield* ThreadQuery.Service
      const interactions = yield* ThreadInteractionRepository.Service
      for (let index = 0; index < 11; index += 1) {
        const suffix = String(index).padStart(2, "0")
        yield* interactions.appendMessage({
          invocationDigest: `outgoing-${suffix}`,
          schemaInputDigest: `outgoing-${suffix}`,
          sourceThreadId: storedThread.id,
          sourceRootTurnId: storedTurn.id,
          now: 50,
          maximumDepth: 3,
          maximumAdmissions: 30,
          maximumWorkspaceActive: 30,
          queueCapacity: 30,
          turnId: Turn.TurnId.make(`outgoing-${suffix}`),
          prompt: `outgoing ${suffix}`,
          executionRoute: storedTurn.executionRoute,
          targetThreadId: relatedThread.id,
          resultDelivery: "manual",
          threadCreationDepth: 1,
        })
        yield* interactions.appendMessage({
          invocationDigest: `incoming-${suffix}`,
          schemaInputDigest: `incoming-${suffix}`,
          sourceThreadId: relatedThread.id,
          sourceRootTurnId: Turn.TurnId.make("outgoing-00"),
          now: 50,
          maximumDepth: 3,
          maximumAdmissions: 30,
          maximumWorkspaceActive: 30,
          queueCapacity: 30,
          turnId: Turn.TurnId.make(`incoming-${suffix}`),
          prompt: `incoming ${suffix}`,
          executionRoute: storedTurn.executionRoute,
          targetThreadId: storedThread.id,
          resultDelivery: "manual",
          threadCreationDepth: 1,
        })
      }

      const first = yield* query.readStructured({ threadId: "one", selector: { _tag: "related" } })
      const continuation = first.omissions[0]?.continuation
      if (continuation?._tag !== "related") return yield* Effect.die("missing relationship continuation")
      const second = yield* query.readStructured({ threadId: "one", selector: continuation })
      const relationships = [...first.relatedThreads, ...second.relatedThreads]
      expect(first.relatedThreads).toHaveLength(20)
      expect(second.relatedThreads).toHaveLength(2)
      expect(relationships).toHaveLength(22)
      expect(relationships.filter((relationship) => relationship.direction === "incoming")).toHaveLength(11)
      expect(relationships.filter((relationship) => relationship.direction === "outgoing")).toHaveLength(11)
      expect(second.omissions).toEqual([])
    }).pipe(provideLayer(queryLayer)),
  )

  it.effect("exposes separate public find handler and maps failures", () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadTools.findToolkit
      const chunks = yield* toolkit.handle("find_thread", { query: "auth" }).pipe(Effect.flatMap(Stream.runCollect))
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)([...chunks])).toContain("Fix auth")
    }).pipe(provideLayer(ThreadToolHandlers.findHandlerLayer.pipe(Layer.provide(queryLayer)))),
  )
})
