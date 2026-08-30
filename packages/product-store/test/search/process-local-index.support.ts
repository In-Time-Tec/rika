import * as ThreadContractModule from "@rika/coding-tools/thread-tool-contract"
import * as ThreadRepositoryModule from "@rika/product/thread-repository"
import * as ThreadSearchRepositoryModule from "@rika/product-store/thread-search-index"
import * as ThreadModule from "@rika/product/thread-record"
import * as TurnRepositoryModule from "@rika/product/turn-repository"
import * as TranscriptRepositoryModule from "@rika/product/transcript-repository"
import * as TurnModule from "@rika/product/turn-record"
import * as ExecutionRouteSnapshotModule from "@rika/product/execution-route-snapshot"
import * as TranscriptOrderingModule from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnitModule from "@rika/transcript/transcript-unit"
import { Effect, Layer } from "effect"

export namespace Fixtures {
  export import ThreadToolkits = ThreadContractModule
  export import ThreadRead = ThreadContractModule
  export import ThreadRepository = ThreadRepositoryModule
  export import ThreadSearchRepository = ThreadSearchRepositoryModule
  export import Thread = ThreadModule
  export import TurnRepository = TurnRepositoryModule
  export import TranscriptRepository = TranscriptRepositoryModule
  export import Turn = TurnModule
  export import ExecutionRouteSnapshot = ExecutionRouteSnapshotModule
  export import TranscriptOrdering = TranscriptOrderingModule
  export import TranscriptUnit = TranscriptUnitModule
}

export const threadRecordsFixture = (initial: ReadonlyArray<ThreadModule.Thread>) => {
  let records = initial
  return Layer.mock(ThreadRepositoryModule.Service, {
    get: (id) => Effect.sync(() => records.find((thread) => thread.id === id)),
    listAll: Effect.sync(() => records),
    rename: (id, title, now) =>
      Effect.gen(function* () {
        const found = records.find((thread) => thread.id === id)
        if (found === undefined)
          return yield* ThreadRepositoryModule.RepositoryError.make({ message: `Thread ${id} does not exist` })
        const renamed = { ...found, title, updatedAt: now }
        records = records.map((thread) => (thread.id === id ? renamed : thread))
        return renamed
      }),
    setArchived: (id, archived, now) =>
      Effect.gen(function* () {
        const found = records.find((thread) => thread.id === id)
        if (found === undefined)
          return yield* ThreadRepositoryModule.RepositoryError.make({ message: `Thread ${id} does not exist` })
        const updated = { ...found, archived, updatedAt: now }
        records = records.map((thread) => (thread.id === id ? updated : thread))
        return updated
      }),
  })
}

export const turnRecordsFixture = (initial: ReadonlyArray<TurnModule.Turn>) => {
  let records = initial
  return Layer.mock(TurnRepositoryModule.Service, {
    get: (id) => Effect.sync(() => records.find((turn) => turn.id === id)),
    list: (threadId) => Effect.sync(() => records.filter((turn) => turn.threadId === threadId)),
    page: (threadId) =>
      Effect.sync(() => ({
        turns: records.filter((turn) => turn.threadId === threadId),
        hasOlder: false,
        oldestCursor: undefined,
        newestCursor: undefined,
      })),
    copy: (turn) =>
      Effect.sync(() => {
        records = [...records, turn]
        return turn
      }),
  })
}
