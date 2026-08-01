import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Effect, FileSystem, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as Thread from "@rika/product/thread-record"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { UnitJson } from "./transcript-sqlite-part-support"
import { createTurn } from "./transcript-sqlite-support"
import { commitAll, event, sqliteLayer } from "./transcript-repository-fixtures"
import { provideLayer } from "./sqlite-schema-support"

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
