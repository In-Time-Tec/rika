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
          expect(migrationRows).toHaveLength(14)
          expect(migrationRows.at(-1)).toEqual({
            migration_id: 14,
            name: "durable_queue_claims",
          })
          const objects = yield* sql`SELECT name FROM sqlite_schema
            WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
            ORDER BY name`
          const names = objects.map((row) => String((row as { readonly name: unknown }).name))
          expect(names).toContain("rika_thread_queue_state")
          expect(names).toContain("rika_turns_queue")
          expect(names).toContain("rika_turns_queue_claim")
          expect(names).toContain("rika_transcript_entries")
          const checkpointColumns = yield* sql`PRAGMA table_info(rika_transcript_checkpoints)`
          const columnNames = checkpointColumns.map((row) => String((row as { readonly name: unknown }).name))
          expect(columnNames).toEqual([
            "turn_id",
            "thread_id",
            "drafts_json",
            "revision",
            "projection_version",
            "oldest_cursor",
            "checkpoint_cursor",
            "cost_usd",
            "updated_at",
            "model_phase",
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
})
