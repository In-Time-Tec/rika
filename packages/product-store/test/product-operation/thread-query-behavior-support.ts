import { describe, expect, it } from "@effect/vitest"
import { Fixtures } from "./thread-query-support"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ThreadQuery, ThreadToolHandlers } from "@rika/product/product-operation-service"
import * as ThreadSearchRepository from "@rika/product/thread-search-repository"
import { provideLayer } from "../support/product-test-layer"
import { delegationUnit, storeProjection } from "../support/product-test-transcript-fixture"

export const workspace = "/work/acme"
export const invocation = Fixtures.ToolInvocation.ToolInvocation.of({
  executionId: "execution-one",
  callId: "call-one",
  toolName: "find_thread",
  eventSequence: 1,
  createdAt: 1,
  idempotencyKeyDigest: "digest",
})
export const storedThread: Fixtures.Thread.Thread = {
  id: Fixtures.Thread.ThreadId.make("one"),
  workspace,
  title: "Fix auth",
  labels: ["bug"],
  pinned: false,
  archived: false,
  lineage: { _tag: "Original" },
  createdAt: 1,
  updatedAt: 2,
}
export const storedTurn: Fixtures.Turn.AgentExecutionTurn = {
  _tag: "AgentExecution",
  id: Fixtures.Turn.TurnId.make("turn-1"),
  threadId: storedThread.id,
  prompt: "fix auth",
  executionRoute: Fixtures.Turn.testExecutionRoute(),
  author: { _tag: "Human" },
  lineage: { _tag: "Original" },
  status: "completed",
  stopIntent: "none",
  createdAt: 1,
  updatedAt: 2,
}
export const projection = (
  units: ReadonlyArray<Fixtures.TranscriptUnit.Unit>,
): Fixtures.TranscriptProjectionModel.Projection => ({
  units,
  revision: units.reduce((maximum, unit) => Math.max(maximum, unit.revision), -1),
  modelPhase: 0,
})
export const relatedThread: Fixtures.Thread.Thread = {
  ...storedThread,
  id: Fixtures.Thread.ThreadId.make("two"),
  title: "Related work",
  createdAt: 3,
  updatedAt: 3,
}
export const stateThreads = (["waiting", "running", "queued", "failed"] as const).map((status, index) => ({
  thread: {
    ...storedThread,
    id: Fixtures.Thread.ThreadId.make(`state-${status}`),
    title: status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
  turn: {
    ...storedTurn,
    id: Fixtures.Turn.TurnId.make(`turn-${status}`),
    threadId: Fixtures.Thread.ThreadId.make(`state-${status}`),
    status,
    createdAt: 10 + index,
    updatedAt: 10 + index,
  },
}))
export const search = Fixtures.ThreadSearchRepository.Service.of({
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
export const repositories = Layer.mergeAll(
  Fixtures.ThreadRepository.memoryLayer([storedThread, relatedThread, ...stateThreads.map(({ thread }) => thread)]),
  Fixtures.TurnRepository.memoryLayer([storedTurn, ...stateThreads.map(({ turn }) => turn)]),
  Fixtures.TranscriptRepository.memoryLayer,
  Layer.succeed(Fixtures.ThreadSearchRepository.Service, search),
  Layer.effect(
    Fixtures.ThreadInteractionRepository.Service,
    Fixtures.ThreadInteractionRepository.makeMemory({ threads: [storedThread, relatedThread], turns: [storedTurn] }),
  ),
)
export const queryLayer = Layer.merge(
  ThreadQuery.layerForWorkspace(workspace).pipe(Layer.provide(repositories)),
  repositories,
)

export { describe, expect, it }
export { Context, Effect, Layer, Schema, Stream }
export { ThreadQuery, ThreadToolHandlers, ThreadSearchRepository, provideLayer, delegationUnit, storeProjection }
export { Fixtures }
