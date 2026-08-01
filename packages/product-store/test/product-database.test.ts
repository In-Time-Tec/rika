import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { layer } from "../src/product-database"
import * as ExecutionRouteSnapshot from "@rika/product/execution-route-snapshot"

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
          expect(migrationRows).toHaveLength(28)
          expect(migrationRows.at(-1)).toEqual({
            migration_id: 28,
            name: "product_route_snapshot",
          })
          const objects = yield* sql`SELECT name FROM sqlite_schema
            WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
            ORDER BY name`
          const names = objects.map((row) => String((row as { readonly name: unknown }).name))
          expect(names).toContain("rika_thread_queue_state")
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
          expect(yield* sql`PRAGMA foreign_keys`).toEqual([{ foreign_keys: 1 }])
        }).pipe(Effect.provide(context))
      }),
    ),
  )

  test.effect("replays the prior migration chain into the invalidated current projection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-consumed-migration-" })
        const filename = `${directory}/rika.db`
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient
            yield* sql`ALTER TABLE rika_turns DROP COLUMN turn_kind`
            yield* sql`ALTER TABLE rika_turns DROP COLUMN shell_command`
            yield* sql`ALTER TABLE rika_turns DROP COLUMN shell_result_text`
            yield* sql`ALTER TABLE rika_turns DROP COLUMN shell_result_truncated`
            yield* sql`ALTER TABLE rika_turns DROP COLUMN shell_result_exit_code`
            yield* sql`INSERT INTO rika_workspaces (path, created_at) VALUES ('/work/legacy', 1)`
            yield* sql`INSERT INTO rika_threads (id, workspace, title, created_at, updated_at)
              VALUES ('thread-legacy', '/work/legacy', 'Legacy', 1, 2)`
            const route = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
              ExecutionRouteSnapshot.testExecutionRoute(),
            )
            yield* sql`INSERT INTO rika_turns (
              id, thread_id, prompt, status, execution_route_json, created_at, updated_at
            ) VALUES (
              'turn-legacy', 'thread-legacy', 'legacy prompt', 'completed',
              ${route}, 2, 3
            )`
            yield* sql`DROP TABLE rika_transcript_execution_checkpoints`
            yield* sql`DROP TABLE rika_transcript_units`
            yield* sql`CREATE TABLE rika_transcript_units (
              unit_key TEXT PRIMARY KEY NOT NULL,
              turn_id TEXT NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
              thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
              unit_sequence INTEGER NOT NULL,
              unit_part INTEGER NOT NULL,
              revision INTEGER NOT NULL,
              unit_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )`
            yield* sql`CREATE INDEX rika_transcript_units_page ON rika_transcript_units (
              thread_id, created_at DESC, turn_id DESC, unit_sequence DESC, unit_part DESC, unit_key DESC
            )`
            yield* sql`CREATE INDEX rika_transcript_units_turn ON rika_transcript_units (
              turn_id, unit_sequence ASC, unit_part ASC, unit_key ASC
            )`
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
            yield* sql`CREATE TABLE rika_transcript_entries (
              turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
              thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
              prompt TEXT NOT NULL,
              status TEXT NOT NULL,
              events_json TEXT NOT NULL DEFAULT '[]',
              revision INTEGER NOT NULL DEFAULT 1,
              projection_version INTEGER NOT NULL DEFAULT 1,
              oldest_cursor TEXT,
              checkpoint_cursor TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )`
            yield* sql`CREATE INDEX rika_transcript_page ON rika_transcript_entries (
              thread_id, created_at DESC, turn_id DESC
            )`
            yield* sql`DROP TABLE rika_thread_root_results`
            yield* sql`DROP TABLE rika_thread_result_routes`
            yield* sql`CREATE TABLE rika_thread_result_routes (
              id TEXT PRIMARY KEY NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('manual', 'reply')),
              source_thread_id TEXT,
              source_turn_id TEXT,
              target_thread_id TEXT NOT NULL,
              target_turn_id TEXT NOT NULL,
              delivery TEXT NOT NULL CHECK (delivery IN ('awaiting-result', 'ready', 'delivered', 'source-unavailable')),
              ready_sequence INTEGER CHECK (ready_sequence IS NULL OR ready_sequence >= 0),
              delivered_turn_id TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              CHECK ((kind = 'manual' AND source_thread_id IS NULL AND source_turn_id IS NULL) OR
                (kind = 'reply' AND source_thread_id IS NOT NULL AND source_turn_id IS NOT NULL)),
              CHECK ((delivery = 'delivered' AND delivered_turn_id IS NOT NULL) OR delivery <> 'delivered'),
              UNIQUE (target_turn_id)
            )`
            yield* sql`CREATE INDEX rika_thread_result_ready ON rika_thread_result_routes
              (delivery, ready_sequence, created_at, id)`
            yield* sql`CREATE TABLE rika_thread_root_readiness (
              turn_id TEXT PRIMARY KEY NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('WaitingReady', 'TerminalReady', 'CancelledBeforeStartReady')),
              cursor TEXT,
              sequence INTEGER CHECK (sequence IS NULL OR sequence >= 0),
              output TEXT,
              backfill INTEGER NOT NULL DEFAULT 0 CHECK (backfill IN (0, 1)),
              updated_at INTEGER NOT NULL,
              CHECK ((state = 'WaitingReady' AND cursor IS NOT NULL) OR state <> 'WaitingReady')
            )`
            yield* sql`DROP INDEX rika_turn_usage_thread`
            yield* sql`ALTER TABLE rika_turn_usage RENAME TO rika_turn_usage_current`
            yield* sql`CREATE TABLE rika_turn_usage (
              turn_id TEXT PRIMARY KEY NOT NULL REFERENCES rika_turns(id) ON DELETE CASCADE,
              thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE,
              revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
              projection_version INTEGER NOT NULL DEFAULT 1,
              fold_json TEXT,
              cost_nano_usd INTEGER,
              tokens INTEGER,
              active_millis INTEGER,
              active_intervals_json TEXT,
              priced_attempts INTEGER NOT NULL DEFAULT 0,
              unpriced_attempts INTEGER NOT NULL DEFAULT 0,
              counted_attempts INTEGER NOT NULL DEFAULT 0,
              uncounted_attempts INTEGER NOT NULL DEFAULT 0,
              source_complete INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL
            )`
            yield* sql`INSERT INTO rika_turn_usage VALUES
              ('turn-legacy', 'thread-legacy', 7, 1, 'legacy-fold', 500, 50, 25, '[]', 2, 3, 4, 5, 1, 3)`
            yield* sql`DROP TABLE rika_turn_usage_current`
            yield* sql`CREATE INDEX rika_turn_usage_thread ON rika_turn_usage (thread_id, turn_id)`
            yield* sql`DELETE FROM rika_migrations WHERE migration_id IN (23, 24, 25, 26, 27, 28)`
          }).pipe(Effect.provide(yield* Layer.build(layer(filename)))),
        )

        const context = yield* Layer.build(layer(filename))
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient
          const columns = yield* sql`PRAGMA table_info(rika_transcript_checkpoints)`
          const names = columns.map((row) => String((row as { readonly name: unknown }).name))
          expect(names).not.toContain("drafts_json")
          expect(names).not.toContain("consumed_json")
          expect(yield* sql`SELECT * FROM rika_transcript_execution_checkpoints`).toEqual([])
          expect(yield* sql`SELECT migration_id, name FROM rika_migrations ORDER BY migration_id DESC LIMIT 1`).toEqual(
            [{ migration_id: 28, name: "product_route_snapshot" }],
          )
          expect(
            yield* sql`SELECT source_id, turn_id, thread_id, revision, projection_version, fold_json,
            cost_nano_usd, tokens, active_millis, active_intervals_json, priced_attempts, unpriced_attempts,
            counted_attempts, uncounted_attempts, source_complete FROM rika_turn_usage`,
          ).toEqual([
            {
              source_id: "turn-legacy",
              turn_id: "turn-legacy",
              thread_id: "thread-legacy",
              revision: 7,
              projection_version: 1,
              fold_json: null,
              cost_nano_usd: null,
              tokens: null,
              active_millis: null,
              active_intervals_json: null,
              priced_attempts: 0,
              unpriced_attempts: 0,
              counted_attempts: 0,
              uncounted_attempts: 0,
              source_complete: 0,
            },
          ])
          expect(yield* sql`SELECT * FROM rika_transcript_checkpoints`).toEqual([
            {
              turn_id: "turn-legacy",
              thread_id: "thread-legacy",
              checkpoint_generation: 4,
              revision: 7,
              projection_version: 2,
              model_phase: -1,
              usable_completion_sequence: null,
              oldest_cursor: null,
              checkpoint_cursor: null,
              cost_usd: null,
              usage_cursors_json: null,
              pricing_version: null,
              updated_at: 3,
            },
          ])
        }).pipe(Effect.provide(context))
      }),
    ),
  )
})
