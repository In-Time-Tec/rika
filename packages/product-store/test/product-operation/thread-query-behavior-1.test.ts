import {
  describe,
  expect,
  it,
  Context,
  Effect,
  Layer,
  Schema,
  ThreadQuery,
  provideLayer,
  Fixtures,
  workspace,
  storedThread,
  storedTurn,
  relatedThread,
  queryLayer,
} from "./thread-query-behavior-support"

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
      const threadRepository = yield* Fixtures.ThreadRepository.makeMemory([local, foreign])
      const turns = yield* Fixtures.TurnRepository.makeMemory([localTurn])
      const transcripts = Context.get(
        yield* Layer.build(Fixtures.TranscriptRepository.memoryLayer),
        Fixtures.TranscriptRepository.Service,
      )
      const searches = yield* Fixtures.ThreadSearchRepository.makeMemory
      const interactions = yield* Fixtures.ThreadInteractionRepository.makeMemory({
        threads: [local, foreign],
        turns: [localTurn],
      })
      const dependencies = Layer.mergeAll(
        Layer.succeed(Fixtures.ThreadRepository.Service, threadRepository),
        Layer.succeed(Fixtures.TurnRepository.Service, turns),
        Layer.succeed(Fixtures.TranscriptRepository.Service, transcripts),
        Layer.succeed(Fixtures.ThreadSearchRepository.Service, searches),
        Layer.succeed(Fixtures.ThreadInteractionRepository.Service, interactions),
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
      const interactions = yield* Fixtures.ThreadInteractionRepository.Service
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
        turnId: Fixtures.Turn.TurnId.make("turn-2"),
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
})
