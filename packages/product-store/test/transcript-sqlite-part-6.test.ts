import * as TranscriptPage from "@rika/product/transcript-page"
import { attachedExecutionCheckpoint } from "./transcript-fixture-checkpoints"
import {
  expect,
  it,
  BunServices,
  TranscriptCorrelation,
  TranscriptOrdering,
  TranscriptProjection,
  Effect,
  FileSystem,
  Thread,
  TranscriptRepository,
  Turn,
  createTurn,
  commitAll,
  executionCheckpoint,
  projectionVersion,
  provideLayer,
  sqliteLayer,
  unit,
} from "./transcript-sqlite-part-support"

it.effect("keyset-paginates a reopened nested intrinsic-order transcript without duplicates", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-page-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-page")
      const turnId = Turn.TurnId.make("turn-page")
      const parentProjection = TranscriptProjection.Projection.project(turnId, "page", [
        {
          cursor: "parent",
          sequence: 0,
          type: "tool.call.requested",
          createdAt: 0,
          data: { tool_call_id: "parent", tool_name: "task", input: {} },
        },
      ])
      const parent = parentProjection.units.find(
        (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
      )
      if (parent?.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
        return yield* Effect.die("page transcript had no parent tool")
      const parentId = parent.content.block.id
      const generated = Array.from({ length: 125 }, (_, index) => {
        const local = unit(turnId, index, 0, `page-unit-${String(index).padStart(3, "0")}`)
        if (index % 2 === 0) return local
        const executionId = `child-${String(index).padStart(3, "0")}`
        return {
          ...local,
          turnId: executionId,
          parentId,
          order: TranscriptOrdering.childOrder(parent.order, executionId, local.order),
        }
      })
      const units = [parent, ...generated]

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "page")
          const projection = {
            ...TranscriptProjection.Projection.empty(turnId, target.prompt),
            units,
            revision: 124,
            costUsd: 4.5,
          }
          const checkpoints = [
            executionCheckpoint(target, projection),
            ...generated.flatMap((candidate) =>
              candidate.turnId === turnId
                ? []
                : [
                    attachedExecutionCheckpoint(
                      candidate.turnId,
                      { revision: candidate.revision, modelPhase: -1 },
                      TranscriptCorrelation.executionKey(String(turnId)),
                      parent,
                    ),
                  ],
            ),
          ]
          yield* commitAll(repository, target, projection, undefined, projectionVersion, checkpoints)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const keys: Array<string> = []
          let before: TranscriptPage.PageCursor | undefined
          while (true) {
            const page = yield* repository.page(threadId, {
              ...(before === undefined ? {} : { before }),
              limit: 17,
            })
            keys.push(...page.entries.map((entry) => entry.unit.key))
            expect(page.threadCostUsd).toBe(4.5)
            if (!page.hasOlder || page.oldestCursor === undefined) break
            before = page.oldestCursor
          }
          expect(keys).toHaveLength(units.length)
          expect(new Set(keys).size).toBe(units.length)
          expect(new Set(keys)).toEqual(new Set(units.map((candidate) => candidate.key)))
          const newest = yield* repository.page(threadId, { limit: 3 })
          if (newest.oldestCursor === undefined) return yield* Effect.die("newest page had no cursor")
          const older = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 3 })
          if (older.newestCursor === undefined) return yield* Effect.die("older page had no cursor")
          const newer = yield* repository.page(threadId, { after: older.newestCursor, limit: 3 })
          expect(new Set([...older.entries, ...newer.entries].map((entry) => entry.unit.key)).size).toBe(
            older.entries.length + newer.entries.length,
          )
          const olderAgain = yield* repository.page(threadId, { before: newest.oldestCursor, limit: 3 })
          expect(olderAgain.entries.map((entry) => entry.unit.key)).toEqual(
            older.entries.map((entry) => entry.unit.key),
          )
          expect(
            (yield* Effect.result(
              repository.page(threadId, { before: newest.oldestCursor, after: older.newestCursor, limit: 3 }),
            ))._tag,
          ).toBe("Failure")
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
