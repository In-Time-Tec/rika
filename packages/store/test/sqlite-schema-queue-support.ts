import * as ExecutionProjection from "@rika/product/execution-projection"
import { expect, test } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer } from "effect"
import * as Database from "@rika/store/product-database-layer"
import * as ThreadRepository from "@rika/store/sqlite-thread-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import { id, create, provideLayer } from "./sqlite-schema-support"

test("reopens a completed nested transcript through the SQLite page", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-nested-transcript-" })
      const filename = `${directory}/rika.db`
      const database = Database.layer(filename)
      const layer = Layer.mergeAll(
        database,
        ThreadRepository.layer.pipe(Layer.provide(database)),
        TurnRepository.layer.pipe(Layer.provide(database)),
        TranscriptRepository.layer.pipe(Layer.provide(database)),
      )
      const expected = yield* Effect.scoped(
        Effect.gen(function* () {
          const threads = yield* ThreadRepository.Service
          const turns = yield* TurnRepository.Service
          const transcripts = yield* TranscriptRepository.Service
          yield* threads.create({ id, workspace: "/work/nested", title: "Nested", now: 1 })
          const target = yield* create(turns, {
            id: Turn.TurnId.make("nested-turn"),
            threadId: id,
            prompt: "delegate",
            now: 2,
          })
          const completed = yield* turns.setStatus(target.id, "completed", 3)
          const subagentId = "subagent:nested-turn:agent"
          const units = [
            {
              key: "subagent:nested-turn:agent",
              turnId: target.id,
              order: unitOrder("subagent:nested-turn:agent", 0),
              revision: 0,
              content: {
                _tag: "Block" as const,
                block: {
                  _tag: "SubagentCard" as const,
                  id: subagentId,
                  name: "inspect",
                  prompt: "inspect",
                  promptTruncated: false,
                  summary: "Checks passed.",
                  status: "complete" as const,
                  activity: [],
                },
              },
            },
            {
              key: "assistant:nested-turn:agent",
              turnId: target.id,
              parentId: subagentId,
              order: unitOrder("assistant:nested-turn:agent", 1),
              revision: 0,
              content: {
                _tag: "Entry" as const,
                role: "assistant" as const,
                text: "## Complete\n\n**Checks passed.**",
              },
            },
          ]
          yield* transcripts.commitProjection(completed, {
            _tag: "ProjectionSnapshot",
            revision: 0,
            checkpoint: { version: 1, cursor: "nested-complete", state: "{}" },
            units,
            hasOlder: false,
            state: {
              status: "completed",
              usage: ExecutionProjection.emptyUsageState(),
              steering: { steeringMessages: 0, followUpMessages: 0 },
            },
          })
          return units
        }).pipe(provideLayer(layer)),
      )
      const reopenedDatabase = Database.layer(filename)
      const reopened = Layer.mergeAll(
        reopenedDatabase,
        TranscriptRepository.layer.pipe(Layer.provide(reopenedDatabase)),
      )
      const page = yield* Effect.scoped(
        Effect.gen(function* () {
          const transcripts = yield* TranscriptRepository.Service
          return yield* transcripts.page(id, { limit: 200 })
        }).pipe(provideLayer(reopened)),
      )
      expect(page.entries.map((entry) => entry.unit)).toEqual([...expected])
      expect(page.entries.filter((entry) => entry.unit.parentId === "subagent:nested-turn:agent")).toHaveLength(1)
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
