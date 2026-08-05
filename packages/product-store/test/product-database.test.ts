import * as BunServices from "@effect/platform-bun/BunServices"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../src/database/product-database-layer"

it.layer(BunServices.layer)("product database", (test) => {
  test.effect("builds the one current schema in a fresh database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-" })
        const context = yield* Layer.build(layer(`${directory}/rika.db`))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const objects = yield* sql`SELECT name FROM sqlite_schema
            WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
            ORDER BY name`
          const names = objects.map((row) => String((row as { readonly name: unknown }).name))
          expect(names).toContain("rika_thread_queue_state")
          expect(
            (yield* sql`PRAGMA table_info(rika_thread_queue_state)`).map((row) =>
              String((row as { readonly name: unknown }).name),
            ),
          ).toEqual(["thread_id", "revision", "queued_count"])
          expect(names).toContain("rika_turns_queue")
          expect(names).toContain("rika_turns_queue_claim")
          expect(names).toContain("rika_transcript_units")
          expect(names).toContain("rika_transcript_checkpoints")
          expect(names).toContain("rika_transcript_execution_checkpoints")
          expect(names).not.toContain("rika_transcript_entries")
          expect(names).toContain("rika_thread_search")
          expect(names).toContain("rika_thread_search_files")
          expect(names).toContain("rika_turn_usage")
          expect(names).not.toContain("rika_usage_repairs")
          expect(names).toContain("rika_thread_picker_summary")
          expect(names).toContain("rika_turns_thread_updated")
          expect(names).toContain("rika_turns_thread_nonqueued")
          const updatedPlan = yield* sql`EXPLAIN QUERY PLAN
            SELECT MAX(updated_at) FROM rika_turns WHERE thread_id = 'thread-a'`
          expect(updatedPlan.map((row) => String((row as { readonly detail: unknown }).detail)).join(" ")).toContain(
            "rika_turns_thread_updated",
          )
          const previewPlan = yield* sql`EXPLAIN QUERY PLAN SELECT * FROM rika_turns
            WHERE thread_id = 'thread-a' AND status <> 'queued'
            ORDER BY created_at DESC, id DESC LIMIT 4`
          expect(previewPlan.map((row) => String((row as { readonly detail: unknown }).detail)).join(" ")).toContain(
            "rika_turns_thread_nonqueued",
          )
          const checkpointColumns = yield* sql`PRAGMA table_info(rika_transcript_checkpoints)`
          const columnNames = checkpointColumns.map((row) => String((row as { readonly name: unknown }).name))
          expect(columnNames).toEqual([
            "turn_id",
            "thread_id",
            "checkpoint_generation",
            "revision",
            "projection_version",
            "model_phase",
            "usable_completion_sequence",
            "oldest_cursor",
            "checkpoint_cursor",
            "cost_usd",
            "usage_cursors_json",
            "pricing_version",
            "updated_at",
          ])
          const executionColumns = yield* sql`PRAGMA table_info(rika_transcript_execution_checkpoints)`
          expect(executionColumns.map((row) => String((row as { readonly name: unknown }).name))).toEqual([
            "turn_id",
            "execution_key",
            "execution_id",
            "cursor",
            "sequence",
            "status",
            "revision",
            "model_phase",
            "usable_completion_sequence",
            "oldest_cursor",
            "checkpoint_cursor",
            "cost_usd",
            "usage_cursors_json",
            "pricing_version",
            "parent_execution_key",
            "parent_unit_key",
            "parent_id",
            "parent_order_key",
            "is_root",
          ])
          const unitColumns = yield* sql`PRAGMA table_info(rika_transcript_units)`
          expect(unitColumns.map((row) => String((row as { readonly name: unknown }).name))).toEqual([
            "turn_id",
            "unit_key",
            "execution_key",
            "thread_id",
            "unit_order_key",
            "tool_id",
            "parent_id",
            "revision",
            "unit_json",
            "created_at",
            "updated_at",
          ])
          const turnColumns = yield* sql`PRAGMA table_info(rika_turns)`
          const turnColumnNames = turnColumns.map((row) => String((row as { readonly name: unknown }).name))
          expect(turnColumnNames).toContain("queue_claim_token")
          expect(turnColumnNames).toContain("turn_kind")
          expect(turnColumnNames).toContain("shell_command")
          expect(turnColumnNames).toContain("shell_result_text")
          expect(turnColumnNames).toContain("shell_result_truncated")
          expect(turnColumnNames).toContain("shell_result_exit_code")
          expect(turnColumnNames).not.toContain("extension_pin_json")
          expect(turnColumnNames).not.toContain("review_fan_out_id")
          expect(turnColumnNames).toContain("execution_link_json")
          expect(yield* sql`PRAGMA foreign_keys`).toEqual([{ foreign_keys: 1 }])
        }).pipe(Effect.provide(context))
      }),
    ),
  )

  test.effect("rejects another existing database without modifying it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-reject-" })
        const filename = `${directory}/rika.db`
        const foreign = yield* Layer.build(SqliteClient.layer({ filename }))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`CREATE TABLE foreign_data (value TEXT NOT NULL)`
          yield* sql`INSERT INTO foreign_data (value) VALUES ('preserve')`
        }).pipe(Effect.provide(foreign))

        const result = yield* Layer.build(layer(filename)).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient
            return yield* sql`SELECT value FROM foreign_data`
          }).pipe(Effect.provide(foreign)),
        ).toEqual([{ value: "preserve" }])
      }),
    ),
  )

  test.effect("rejects drift from the current schema without modifying it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-drift-" })
        const filename = `${directory}/rika.db`
        yield* Effect.scoped(Layer.build(layer(filename)))
        const client = yield* Layer.build(SqliteClient.layer({ filename }))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          yield* sql`ALTER TABLE rika_workspaces ADD COLUMN unexpected TEXT`
          yield* sql`INSERT INTO rika_workspaces (path, created_at, unexpected) VALUES ('/preserve', 1, 'value')`
        }).pipe(Effect.provide(client))

        expect((yield* Layer.build(layer(filename)).pipe(Effect.exit))._tag).toBe("Failure")
        expect(
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient
            return yield* sql`SELECT unexpected FROM rika_workspaces WHERE path = '/preserve'`
          }).pipe(Effect.provide(client)),
        ).toEqual([{ unexpected: "value" }])
      }),
    ),
  )
})
