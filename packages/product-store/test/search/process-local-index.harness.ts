import * as ThreadQuery from "@rika/product/thread-query-service"
import { Fixtures, threadRecordsFixture, turnRecordsFixture } from "./process-local-index.support"
import { Effect, Layer } from "effect"
import * as ThreadSearchRepository from "@rika/product/thread-search-repository"

import { workspace, storedThread, storedTurn, relatedThread, stateThreads } from "./process-local-index.fixture"
export const search = Fixtures.ThreadSearchRepository.Service.of({
  search: (input) =>
    Effect.sync(() => {
      let results: Effect.Success<ReturnType<ThreadSearchRepository.Interface["search"]>>["results"] = []
      if (input.workspace === workspace && input.query === "states") {
        results = stateThreads.map(({ thread }) => ({
          schemaVersion: 1,
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
            schemaVersion: 1,
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
        schemaVersion: 1,
        results,
        nextCursor: undefined,
      }
    }),
  rebuildThread: () => Effect.void,
  removeThread: () => Effect.void,
})
export const repositories = Layer.mergeAll(
  threadRecordsFixture([storedThread, relatedThread, ...stateThreads.map(({ thread }) => thread)]),
  turnRecordsFixture([storedTurn, ...stateThreads.map(({ turn }) => turn)]),
  Fixtures.TranscriptRepository.memoryLayer(),
  Layer.succeed(Fixtures.ThreadSearchRepository.Service, search),
)
export const queryLayer = Layer.merge(
  ThreadQuery.Runtime.layerForWorkspace(workspace).pipe(Layer.provide(repositories)),
  repositories,
)
