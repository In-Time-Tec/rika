import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../src/product-database"

it.layer(BunServices.layer)("product database", (test) => {
  test.effect("builds the current schema through the ordered migration history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-product-database-" })
        const context = yield* Layer.build(layer(`${directory}/rika.db`))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const migrationRows = yield* sql`SELECT migration_id, name FROM rika_migrations ORDER BY migration_id`
          expect(migrationRows).toHaveLength(24)
          expect(migrationRows.at(-1)).toEqual({
            migration_id: 24,
            name: "drop_usage_repairs",
          })
          const objects = yield* sql`SELECT name FROM sqlite_schema
            WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
            ORDER BY name`
          const names = objects.map((row) => String((row as { readonly name: unknown }).name))
          expect(names).toContain("rika_thread_queue_state")
          expect(names).toContain("rika_turns_queue")
          expect(names).toContain("rika_turns_queue_claim")
          expect(names).toContain("rika_transcript_entries")
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
            "revision",
            "projection_version",
            "model_phase",
            "oldest_cursor",
            "checkpoint_cursor",
            "cost_usd",
            "usage_cursors_json",
            "consumed_json",
            "pricing_version",
            "child_tree_reconciled",
            "projection_generation",
            "updated_at",
          ])
          const turnColumns = yield* sql`PRAGMA table_info(rika_turns)`
          expect(turnColumns.map((row) => String((row as { readonly name: unknown }).name))).toContain(
            "queue_claim_token",
          )
          expect(yield* sql`PRAGMA foreign_keys`).toEqual([{ foreign_keys: 1 }])
        }).pipe(Effect.provide(context))
      }),
    ),
  )

  test.effect("folds consumption state into checkpoints written by the prior migration chain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-consumed-migration-" })
        const filename = `${directory}/rika.db`
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient
            yield* sql`INSERT INTO rika_workspaces (path, created_at) VALUES ('/work/legacy', 1)`
            yield* sql`INSERT INTO rika_threads (id, workspace, title, created_at, updated_at)
              VALUES ('thread-legacy', '/work/legacy', 'Legacy', 1, 2)`
            yield* sql`INSERT INTO rika_turns (id, thread_id, prompt, status, created_at, updated_at)
              VALUES ('turn-legacy', 'thread-legacy', 'legacy prompt', 'completed', 2, 3)`
            yield* sql`DROP TABLE rika_transcript_checkpoints`
            yield* sql`CREATE TABLE rika_transcript_checkpoints (
              turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
              thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
              drafts_json TEXT NOT NULL DEFAULT '[]',
              revision INTEGER NOT NULL DEFAULT -1,
              projection_version INTEGER NOT NULL DEFAULT 2,
              oldest_cursor TEXT,
              checkpoint_cursor TEXT,
              cost_usd REAL,
              updated_at INTEGER NOT NULL,
              model_phase INTEGER NOT NULL DEFAULT -1,
              usage_cursors_json TEXT,
              pricing_version TEXT,
              child_tree_reconciled INTEGER NOT NULL DEFAULT 0 CHECK (child_tree_reconciled IN (0, 1)),
              projection_generation INTEGER NOT NULL DEFAULT 0 CHECK (projection_generation >= 0)
            )`
            yield* sql`INSERT INTO rika_transcript_checkpoints (
              turn_id, thread_id, revision, oldest_cursor, checkpoint_cursor, cost_usd, updated_at,
              model_phase, usage_cursors_json, pricing_version, child_tree_reconciled, projection_generation
            ) VALUES ('turn-legacy', 'thread-legacy', 7, 'cursor-0', 'cursor-7', 0.5, 3, 2,
              '["usage-1"]', 'pricing-1', 1, 4)`
            yield* sql`CREATE TABLE rika_usage_repairs (
              turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
              claim_token TEXT,
              checkpoint_json TEXT,
              updated_at INTEGER NOT NULL
            )`
            yield* sql`DELETE FROM rika_migrations WHERE migration_id IN (23, 24)`
          }).pipe(Effect.provide(yield* Layer.build(layer(filename)))),
        )

        const context = yield* Layer.build(layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const columns = yield* sql`PRAGMA table_info(rika_transcript_checkpoints)`
          const names = columns.map((row) => String((row as { readonly name: unknown }).name))
          expect(names).not.toContain("drafts_json")
          expect(names).toContain("consumed_json")
          expect(yield* sql`SELECT migration_id, name FROM rika_migrations ORDER BY migration_id DESC LIMIT 1`).toEqual(
            [{ migration_id: 24, name: "drop_usage_repairs" }],
          )
          expect(yield* sql`SELECT * FROM rika_transcript_checkpoints`).toEqual([
            {
              turn_id: "turn-legacy",
              thread_id: "thread-legacy",
              revision: 7,
              projection_version: 1,
              model_phase: 2,
              oldest_cursor: "cursor-0",
              checkpoint_cursor: "cursor-7",
              cost_usd: 0.5,
              usage_cursors_json: '["usage-1"]',
              consumed_json: null,
              pricing_version: "pricing-1",
              child_tree_reconciled: 1,
              projection_generation: 4,
              updated_at: 3,
            },
          ])
        }).pipe(Effect.provide(context))
      }),
    ),
  )
})
