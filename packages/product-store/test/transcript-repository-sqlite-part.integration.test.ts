import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Thread from "@rika/product/thread-record"
import * as ThreadRepository from "../src/thread/sqlite-thread-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as Turn from "@rika/product/turn-record"
import {
  attachedExecutionCheckpoint,
  commitAll,
  event,
  executionCheckpoint,
  projectionVersion,
  provideLayer,
  sqliteLayer,
  unit,
} from "./transcript-repository-fixtures"

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)

const usageEvent: TranscriptSourceEvent.SourceEvent = {
  cursor: "usage-5",
  sequence: 5,
  type: "model.usage.reported",
  createdAt: 5,
  data: {
    provider: "openai",
    model: "gpt-5.6-sol",
    input_tokens: 250_000,
    input_tokens_uncached: 250_000,
    input_tokens_cache_read: 0,
    input_tokens_cache_write: 0,
    output_tokens: 0,
  },
}

const _compareExecutionCheckpoints = (
  left: TranscriptRepository.ExecutionCheckpoint,
  right: TranscriptRepository.ExecutionCheckpoint,
): number => {
  if (left.executionKey < right.executionKey) return -1
  if (left.executionKey > right.executionKey) return 1
  return 0
}

const createTurn = Effect.fn("TranscriptRepositoryTest.createTurn")(function* (
  threadId: Thread.ThreadId,
  turnId: Turn.TurnId,
  prompt: string,
) {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  if ((yield* threads.get(threadId)) === undefined)
    yield* threads.create({ id: threadId, workspace: `/work/${threadId}`, title: String(threadId), now: 1 })
  yield* turns.createForSubmission({
    id: turnId,
    threadId,
    prompt,
    executionRoute: Turn.testExecutionRoute(),
    queueCapacity: 128,
    now: 2,
  })
  return yield* turns.setStatus(turnId, "completed", undefined, 3)
})

it.effect("rejects a refold when the SQLite Turn tuple advanced concurrently", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-stale-turn-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-refold-stale-turn"),
            Turn.TurnId.make("turn-refold-stale-turn"),
            "refold stale turn",
          )
          const obsolete = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)])
          yield* commitAll(repository, target, obsolete, undefined, 2)
          const before = yield* repository.get(target.id)
          if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
          expect(yield* turns.repairCursor(target.id, "completed", undefined, "newer-cursor")).toBe(true)
          const newer = yield* turns.get(target.id)
          const preserved = yield* repository.get(target.id)
          const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [
            { cursor: "refold-failed", sequence: 0, type: "execution.failed", createdAt: 10, text: "failed" },
          ])

          expect(
            yield* repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: before.checkpointGeneration,
            }),
          ).toEqual({ _tag: "Stale" })
          expect(yield* turns.get(target.id)).toEqual(newer)
          expect(yield* repository.get(target.id)).toEqual(preserved)
        }).pipe(provideLayer(sqliteLayer(`${directory}/rika.db`))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("rejects contradictory durable checkpoint and projected terminal outcomes during refold", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-refold-contradiction-" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const turns = yield* TurnRepository.Service
          const target = yield* createTurn(
            Thread.ThreadId.make("thread-refold-contradiction"),
            Turn.TurnId.make("turn-refold-contradiction"),
            "refold contradiction",
          )
          const obsolete = TranscriptProjection.Projection.project(target.id, target.prompt, [event(0), event(1)])
          yield* commitAll(repository, target, obsolete, undefined, 2)
          const before = yield* repository.get(target.id)
          if (before === undefined) return yield* Effect.die("obsolete projection was not stored")
          const replacement = TranscriptProjection.Projection.project(target.id, target.prompt, [
            { cursor: "cancelled", sequence: 0, type: "execution.cancelled", createdAt: 10 },
          ])
          const rejected = yield* Effect.result(
            repository.replaceForRefold(target, replacement, {
              executionCheckpoints: [executionCheckpoint(target, replacement, "failed")],
              projectionVersion,
              expectedProjectionVersion: 2,
              expectedGeneration: before.checkpointGeneration,
            }),
          )
          expect(rejected._tag).toBe("Failure")
          if (rejected._tag === "Failure")
            expect(rejected.failure.message).toContain("contradictory terminal root outcomes")
          expect(yield* turns.get(target.id)).toEqual(target)
          expect(yield* repository.get(target.id)).toEqual(before)
        }).pipe(provideLayer(sqliteLayer(`${directory}/rika.db`))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("persists a terminal outcome appended after the initial projection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-outcome-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-outcome")
      const turnId = Turn.TurnId.make("turn-outcome")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "outcome")
          const initial = TranscriptProjection.Projection.project(turnId, target.prompt, [event(0)])
          yield* commitAll(repository, target, initial, undefined)
          const stored = yield* repository.get(turnId)
          if (stored === undefined) return yield* Effect.die("initial projection was not stored")
          const completed = TranscriptProjection.Projection.applyEvent(initial, event(2))
          const previous = new Map(initial.units.map((candidate) => [candidate.key, candidate]))
          const changed = completed.units.filter(
            (candidate) => JSON.stringify(candidate) !== JSON.stringify(previous.get(candidate.key)),
          )
          expect(
            yield* repository.commitDelta(
              target,
              TranscriptProjection.Projection.projectionState(completed),
              { upsert: changed, remove: [] },
              {
                executionCheckpoints: [executionCheckpoint(target, completed, "completed")],
                projectionVersion,
                expectedGeneration: stored.checkpointGeneration,
              },
            ),
          ).toBe("committed")
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          if (reopened === undefined) return yield* Effect.die("terminal projection was not reopened")
          if (!Turn.isAgentExecution(reopened.turn))
            return yield* Effect.die("terminal projection did not reopen an agent execution")
          expect(reopened?.units.find((candidate) => candidate.key === `turn:${turnId}:user`)).toMatchObject({
            revision: 2,
            executionOutcome: { status: "complete" },
          })
          expect(reopened.executionCheckpoints).toContainEqual(
            executionCheckpoint(reopened.turn, reopened, "completed"),
          )
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("restores usage dedup state before a redelivered usage event", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-usage-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-usage")
      const turnId = Turn.TurnId.make("turn-usage")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const target = yield* createTurn(threadId, turnId, "usage")
          yield* commitAll(
            repository,
            target,
            TranscriptProjection.Projection.project(turnId, target.prompt, [usageEvent]),
            undefined,
          )
        }).pipe(provideLayer(sqliteLayer(filename))),
      )

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const reopened = yield* repository.get(turnId)
          if (reopened === undefined) return yield* Effect.die("usage projection was not stored")
          const resumed: TranscriptProjectionModel.Projection = {
            units: reopened.units,
            ...TranscriptProjection.Projection.projectionState(reopened),
          }
          const redelivered = TranscriptProjection.Projection.applyEvent(resumed, usageEvent)
          expect(TranscriptProjection.Projection.projectionState(redelivered)).toEqual(
            TranscriptProjection.Projection.projectionState(resumed),
          )
          expect(redelivered.usageCursors).toEqual([usageEvent.cursor])
          expect(redelivered.costUsd).toBe(resumed.costUsd)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("filters every SQLite keyset page by exact projection version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-version-filter-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-version-filter")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const stale = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-stale"), "stale")
          const currentOlder = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-current-a"), "current older")
          const currentNewer = yield* createTurn(threadId, Turn.TurnId.make("turn-filter-current-b"), "current newer")
          for (const [target, version] of [
            [stale, 2],
            [currentOlder, projectionVersion],
            [currentNewer, projectionVersion],
          ] as const)
            yield* commitAll(
              repository,
              target,
              TranscriptProjection.Projection.empty(target.id, target.prompt),
              undefined,
              version,
            )

          const newest = yield* repository.page(threadId, { limit: 1, projectionVersion })
          expect(newest.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
          expect(newest.hasOlder).toBe(true)
          if (newest.oldestCursor === undefined) return yield* Effect.die("filtered page had no oldest cursor")

          const older = yield* repository.page(threadId, {
            before: newest.oldestCursor,
            limit: 1,
            projectionVersion,
          })
          expect(older.entries.map((entry) => entry.turn.id)).toEqual([currentOlder.id])
          expect(older.hasOlder).toBe(false)
          if (older.newestCursor === undefined) return yield* Effect.die("filtered page had no newest cursor")

          const newer = yield* repository.page(threadId, {
            after: older.newestCursor,
            limit: 1,
            projectionVersion,
          })
          expect(newer.entries.map((entry) => entry.turn.id)).toEqual([currentNewer.id])
          expect(newer.hasNewer).toBe(false)
          expect(
            (yield* repository.page(threadId, { limit: 10, projectionVersion: 2 })).entries.map(
              (entry) => entry.turn.id,
            ),
          ).toEqual([stale.id])
          expect((yield* repository.page(threadId, { limit: 10, projectionVersion: 4 })).entries).toEqual([])
          expect(
            new Set((yield* repository.page(threadId, { limit: 10 })).entries.map((entry) => entry.turn.id)),
          ).toEqual(new Set([stale.id, currentOlder.id, currentNewer.id]))
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

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
          let before: TranscriptRepository.PageCursor | undefined
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

it.effect("orders Unicode and nested order segments exactly like SQLite BINARY", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-collation-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-collation")
      const turnId = Turn.TurnId.make("turn-collation")

      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const target = yield* createTurn(threadId, turnId, "collation")
          const flat = ["a", "aa", "\ud7ff", "\u{10000}", "\ue000"].map((key) => unit(turnId, 1, 0, key))
          const parentProjection = TranscriptProjection.Projection.project(turnId, target.prompt, [
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
            return yield* Effect.die("collation transcript had no parent tool")
          const parentId = parent.content.block.id
          const nested = ["child-\ud7ff", "child-\u{10000}", "child-\ue000"].map((executionId, index) => {
            const local = unit(turnId, 1, 0, `nested-${index}`)
            return Object.assign({}, local, {
              turnId: executionId,
              parentId,
              order: TranscriptOrdering.childOrder(parent.order, executionId, local.order),
            })
          })
          const units = [parent, ...flat, ...nested]
          const projection = { ...TranscriptProjection.Projection.empty(turnId, target.prompt), units, revision: 1 }
          yield* commitAll(repository, target, projection, undefined, projectionVersion, [
            executionCheckpoint(target, projection),
            ...nested.map((candidate) =>
              attachedExecutionCheckpoint(
                candidate.turnId,
                { revision: candidate.revision, modelPhase: -1 },
                TranscriptCorrelation.executionKey(String(turnId)),
                parent,
              ),
            ),
          ])
          const expected = units
            .toSorted((left, right) => TranscriptOrdering.compareUnitOrder(left.order, right.order))
            .map((candidate) => candidate.key)
          const durable = yield* sql`SELECT unit_key FROM rika_transcript_units
            WHERE turn_id = ${turnId} ORDER BY unit_order_key COLLATE BINARY`
          expect(durable.map((row) => row.unit_key)).toEqual(expected)
          expect((yield* repository.get(turnId))?.units.map((candidate) => candidate.key)).toEqual(expected)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)

it.effect("returns typed errors for malformed durable transcript state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-transcript-order-corrupt-" })
      const filename = `${directory}/rika.db`
      const threadId = Thread.ThreadId.make("thread-corrupt")
      const turnId = Turn.TurnId.make("turn-corrupt")
      const projection = TranscriptProjection.Projection.project(turnId, "corrupt", [
        event(0),
        {
          cursor: "cursor-tool",
          sequence: 1,
          type: "tool.call.requested",
          createdAt: 1,
          data: { tool_call_id: "tool", tool_name: "read", input: { path: "a.ts" } },
        },
      ])
      const firstUnit = projection.units[0]!
      const toolUnit = projection.units.find(
        (candidate) => candidate.content._tag === "Block" && candidate.content.block._tag === "ToolCall",
      )!
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const target = yield* createTurn(threadId, turnId, "corrupt")
          yield* commitAll(repository, target, projection, undefined)
          yield* sql`UPDATE rika_transcript_units SET unit_order_key = unit_order_key || '0'
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
      yield* Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* TranscriptRepository.Service
          const sql = yield* SqlClient
          const failure = yield* Effect.flip(repository.get(turnId))
          expect(failure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(failure._tag).toBe("TranscriptRepositoryError")
          const pageFailure = yield* Effect.flip(repository.page(threadId, { limit: 200 }))
          expect(pageFailure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units
            SET unit_order_key = ${TranscriptOrdering.encodeUnitOrder(firstUnit.order)}, unit_key = 'wrong-key'
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units
            SET unit_key = ${firstUnit.key}, unit_order_key = ${TranscriptOrdering.encodeUnitOrder(firstUnit.order)}, unit_json = ${"{"}
            WHERE turn_id = ${turnId} AND unit_key = 'wrong-key'`
          const unitJsonFailure = yield* Effect.flip(repository.get(turnId))
          expect(unitJsonFailure).toBeInstanceOf(TranscriptRepository.RepositoryError)
          const firstUnitJson = yield* Schema.encodeEffect(UnitJson)(firstUnit)
          const forgedParentJson = yield* Schema.encodeEffect(UnitJson)({ ...firstUnit, parentId: "forged-parent" })
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${firstUnitJson}
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${forgedParentJson}
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${firstUnitJson}
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          yield* sql`UPDATE rika_transcript_units SET parent_id = 'forged-parent'
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET parent_id = NULL
            WHERE turn_id = ${turnId} AND unit_key = ${firstUnit.key}`
          if (toolUnit.content._tag !== "Block" || toolUnit.content.block._tag !== "ToolCall")
            return yield* Effect.die("corrupt transcript had no tool")
          const forgedToolJson = yield* Schema.encodeEffect(UnitJson)({
            ...toolUnit,
            content: {
              _tag: "Block",
              block: { ...toolUnit.content.block, id: "forged-tool" },
            },
          })
          const toolUnitJson = yield* Schema.encodeEffect(UnitJson)(toolUnit)
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${forgedToolJson}
            WHERE turn_id = ${turnId} AND unit_key = ${toolUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET unit_json = ${toolUnitJson}, tool_id = 'forged-tool'
            WHERE turn_id = ${turnId} AND unit_key = ${toolUnit.key}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          expect(yield* Effect.flip(repository.page(threadId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_units SET tool_id = ${toolUnit.content.block.id}
            WHERE turn_id = ${turnId} AND unit_key = ${toolUnit.key}`
          const rootKey = TranscriptCorrelation.executionKey(String(turnId))
          yield* sql`UPDATE rika_transcript_execution_checkpoints
            SET usage_cursors_json = ${"{"}
            WHERE turn_id = ${turnId} AND execution_key = ${rootKey}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
          yield* sql`UPDATE rika_transcript_execution_checkpoints SET usage_cursors_json = NULL
            WHERE turn_id = ${turnId} AND execution_key = ${rootKey}`
          yield* sql`UPDATE rika_transcript_checkpoints
            SET model_phase = model_phase + 1
            WHERE turn_id = ${turnId}`
          expect(yield* Effect.flip(repository.get(turnId))).toBeInstanceOf(TranscriptRepository.RepositoryError)
        }).pipe(provideLayer(sqliteLayer(filename))),
      )
    }),
  ).pipe(provideLayer(BunServices.layer)),
)
