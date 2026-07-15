import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { vi } from "vitest"
import { makeRecordingSql } from "./recording-sql"

const sql = makeRecordingSql()
const filenames: Array<string> = []
const migrationTables: Array<string> = []
const migrationNames: Array<string> = []

type Migration = Effect.Effect<void, never, SqlClient>
type MigrationRecord = Record<string, Migration>

vi.mock("@effect/sql-sqlite-bun/SqliteClient", () => ({
  layer: ({ filename }: { readonly filename: string }) => {
    filenames.push(filename)
    return sql.layer
  },
}))

vi.mock("@effect/sql-sqlite-bun/SqliteMigrator", () => ({
  fromRecord: (record: MigrationRecord) => {
    migrationNames.push(...Object.keys(record))
    return record
  },
  layer: ({ loader, table }: { readonly loader: MigrationRecord; readonly table: string }) => {
    migrationTables.push(table)
    return Layer.effectDiscard(Effect.forEach(Object.values(loader), (migration) => migration, { discard: true }))
  },
}))

const { clientLayer, layer } = await import("../src/product-database")

it.effect("builds the client directory and applies all product migrations in order", () => {
  const directories: Array<
    readonly [string, { readonly recursive?: boolean | undefined; readonly mode?: number | undefined } | undefined]
  > = []
  const fileSystem = FileSystem.layerNoop({
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        directories.push([path, options])
      }),
  })
  const dependencies = Layer.merge(fileSystem, Path.layer)
  const filename = "/data/rika/product.sqlite"

  return Effect.gen(function* () {
    yield* Layer.build(clientLayer(filename).pipe(Layer.provide(dependencies)))
    yield* Layer.build(layer(filename).pipe(Layer.provide(dependencies)))

    expect(directories).toEqual([
      ["/data/rika", { recursive: true }],
      ["/data/rika", { recursive: true }],
    ])
    expect(filenames).toEqual([filename, filename])
    expect(migrationTables).toEqual(["rika_migrations"])
    expect(migrationNames).toEqual([
      "1_product_baseline",
      "2_turns",
      "3_queued_turn_status",
      "4_execution_extension_pins",
      "5_turn_prompt_parts",
      "6_drop_thread_session_id",
      "7_execution_route_pins",
      "8_review_fan_out_owners",
    ])
    expect(sql.statements.map((statement) => statement.sql)).toEqual([
      "CREATE TABLE rika_workspaces ( path TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL )",
      "CREATE TABLE rika_threads ( id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL REFERENCES rika_workspaces(path), title TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )",
      "CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)",
      "CREATE TABLE rika_turns ( id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'waiting', 'completed', 'failed', 'cancelled')), last_cursor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )",
      "CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)",
      "CREATE TABLE rika_turns_next ( id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL REFERENCES rika_threads(id) ON DELETE CASCADE, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')), last_cursor TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )",
      "INSERT INTO rika_turns_next SELECT * FROM rika_turns",
      "DROP TABLE rika_turns",
      "ALTER TABLE rika_turns_next RENAME TO rika_turns",
      "CREATE INDEX rika_turns_thread ON rika_turns (thread_id, created_at ASC, id ASC)",
      "ALTER TABLE rika_turns ADD COLUMN extension_pin_json TEXT",
      "ALTER TABLE rika_turns ADD COLUMN prompt_parts_json TEXT",
      "CREATE TABLE rika_threads_next ( id TEXT PRIMARY KEY NOT NULL, workspace TEXT NOT NULL REFERENCES rika_workspaces(path), title TEXT NOT NULL, labels_json TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL )",
      "INSERT INTO rika_threads_next SELECT id, workspace, title, labels_json, pinned, archived, created_at, updated_at FROM rika_threads",
      "DROP TABLE rika_threads",
      "ALTER TABLE rika_threads_next RENAME TO rika_threads",
      "CREATE INDEX rika_threads_listing ON rika_threads (pinned DESC, updated_at DESC, id ASC)",
      "ALTER TABLE rika_turns ADD COLUMN execution_route_json TEXT",
      "ALTER TABLE rika_turns ADD COLUMN review_fan_out_id TEXT",
    ])
    expect(sql.statements.every((statement) => statement.parameters.length === 0)).toBe(true)
  })
})
