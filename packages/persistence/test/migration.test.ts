import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Common, Event, Ids } from "@rika/schema"
import { Database, Migration, ThreadEventLog } from "../src/index"

const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, ThreadEventLog.layer)

describe("Migration", () => {
  test("applies committed migrations at runtime", async () => {
    const tables = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Database.withDatabase((database) =>
          database.all<{ name: string }>(sql`select name from sqlite_master where type = 'table' order by name`),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(tables.map((table) => table.name)).toContain("thread_events")
  })

  test("applies projection columns used by thread summaries", async () => {
    const columns = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        return yield* Database.withDatabase((database) =>
          database.all<{ name: string }>(sql`pragma table_info(thread_projections)`),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["title_text", "diff_additions", "diff_modifications", "diff_deletions"]),
    )
  })

  test("backfills thread files from historical event log rows", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadEventLog.appendMany([historicalThreadCreated, historicalToolRequested])
        const before = yield* Database.withDatabase((database) =>
          database.all<{ path: string }>(sql`select path from thread_files order by path asc`),
        )
        yield* Migration.migrate()
        const after = yield* Database.withDatabase((database) =>
          database.all<{ thread_id: string; path: string }>(
            sql`select thread_id, path from thread_files order by thread_id asc, path asc`,
          ),
        )
        return { before, after }
      }).pipe(Effect.provide(layer)),
    )

    expect(rows.before).toEqual([])
    expect(rows.after).toEqual([{ thread_id: historicalThreadId, path: "packages/server/src/search.ts" }])
  })

  test("resolves source, configured, and installed migration folders", () => {
    expect(Migration.migrationsFolderFromEnv({ RIKA_MIGRATIONS_DIR: "/tmp/rika-migrations" })).toBe(
      "/tmp/rika-migrations",
    )
    expect(Migration.migrationsFolderFromEnv({})).toBe(Migration.sourceMigrationsFolder)
    expect(Migration.installedMigrationsFolder("/opt/rika/bin/rika")).toBe("/opt/rika/share/rika/drizzle")
  })
})

const historicalThreadId = Ids.ThreadId.make("migration_thread_file_backfill")
const historicalTurnId = Ids.TurnId.make("migration_turn_file_backfill")
const historicalCreatedAt = Common.TimestampMillis.make(1_789_000_000_000)

const historicalThreadCreated: Event.ThreadCreated = {
  id: Ids.EventId.make("migration_thread_file_backfill_created"),
  thread_id: historicalThreadId,
  sequence: 1,
  version: 1,
  created_at: historicalCreatedAt,
  type: "thread.created",
  data: { workspace_id: Ids.WorkspaceId.make("migration_workspace_file_backfill") },
}

const historicalToolRequested: Event.ToolCallRequested = {
  id: Ids.EventId.make("migration_thread_file_backfill_tool"),
  thread_id: historicalThreadId,
  turn_id: historicalTurnId,
  sequence: 2,
  version: 1,
  created_at: historicalCreatedAt,
  type: "tool.call.requested",
  data: {
    call: {
      id: Ids.ToolCallId.make("migration_thread_file_backfill_call"),
      name: "edit",
      input: { path: "packages/server/src/search.ts" },
    },
  },
}
