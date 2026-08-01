import { expect, test } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import { Database as NativeDatabase } from "bun:sqlite"
import { Effect, FileSystem, Layer } from "effect"
import * as Database from "@rika/product-store/product-database-layer"
import * as ThreadRepository from "@rika/product-store/sqlite-thread-repository"
import * as TurnRepository from "../src/turn/sqlite-turn-repository"
import * as TranscriptRepository from "../src/transcript/sqlite-transcript-repository"
import * as Turn from "@rika/product/turn-record"
import { id, create, provideLayer } from "./sqlite-schema-support"
import { commitAll, executionCheckpoint, projectionVersion } from "./transcript-repository-fixtures"
import { attachedExecutionCheckpoint } from "./transcript-fixture-checkpoints"
import * as TranscriptNestedProjection from "@rika/transcript/nested-transcript-projection"

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
          const completed = yield* turns.setStatus(target.id, "completed", "parent-done", 3)
          const childId = "nested-turn:child:agent"
          const parent = TranscriptProjection.Projection.project(target.id, target.prompt, [
            {
              cursor: "agent",
              sequence: 0,
              type: "tool.call.requested",
              createdAt: 2,
              data: { tool_call_id: "agent", tool_name: "task", input: { prompt: "inspect" } },
            },
            {
              cursor: "spawned",
              sequence: 1,
              type: "child_run.spawned",
              createdAt: 2,
              data: { tool_call_id: "agent", child_execution_id: `execution:${childId}` },
            },
            { cursor: "parent-done", sequence: 2, type: "execution.completed", createdAt: 3 },
          ])
          const child = TranscriptProjection.Projection.project(childId, "", [
            {
              cursor: "answer",
              sequence: 0,
              type: "model.output.completed",
              createdAt: 3,
              text: "## Complete\n\n**Checks passed.**",
            },
            { cursor: "child-done", sequence: 1, type: "execution.completed", createdAt: 3 },
          ])
          const projection = TranscriptNestedProjection.withNestedProjections(parent, [
            { parentId: `${target.id}:agent`, projection: child },
          ])
          const parentTool = parent.units.find(
            (unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall",
          )
          if (parentTool === undefined) return yield* Effect.die("nested transcript had no parent tool")
          yield* commitAll(transcripts, completed, projection, undefined, projectionVersion, [
            executionCheckpoint(completed, projection),
            attachedExecutionCheckpoint(
              childId,
              child,
              TranscriptCorrelation.executionKey(String(target.id)),
              parentTool,
              "completed",
            ),
          ])
          return projection.units
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
      expect(page.entries.filter((entry) => entry.unit.parentId === "nested-turn:agent")).toHaveLength(2)
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})

test("rejects an incompatible database without mutating it", () => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-incompatible-" })
      const filename = `${directory}/rika.db`
      yield* Effect.sync(() => {
        const database = new NativeDatabase(filename)
        database.exec("CREATE TABLE old_sessions (id TEXT PRIMARY KEY)")
        database.close()
      })
      const before = yield* fileSystem.readFile(filename)
      const result = yield* Effect.result(Effect.scoped(Layer.build(Database.layer(filename))))
      const after = yield* fileSystem.readFile(filename)
      const files = yield* fileSystem.readDirectory(directory)
      const names = yield* Effect.sync(() => {
        const database = new NativeDatabase(filename, { readonly: true })
        const rows = database
          .query<
            { name: string },
            []
          >("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all()
        database.close()
        return rows.map((row) => row.name)
      })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(String(result.failure)).toContain("Use a fresh Rika data root")
      expect([...after]).toEqual([...before])
      expect(files).toEqual(["rika.db"])
      expect(names).toEqual(["old_sessions"])
    }),
  )
  return Effect.runPromise(Effect.scoped(program.pipe(provideLayer(BunServices.layer))))
})
