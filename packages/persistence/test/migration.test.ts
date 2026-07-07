import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Common, Event, Ids } from "@rika/schema"
import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactStore, Database, Migration, ThreadEventLog } from "../src/index"

const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer, ThreadEventLog.layer)
const artifactWorkspaceBackfillMigration = "20260706000000_artifacts_workspace_backfill"

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

  test("backfills legacy NULL artifact workspace ids from thread projections", async () => {
    const priorMigrations = await migrationsFolderWithout(artifactWorkspaceBackfillMigration)
    try {
      const databaseLayer = Database.memoryLayer
      const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
      const testLayer = Layer.mergeAll(databaseLayer, artifactLayer)
      const workspaceId = Ids.WorkspaceId.make("migration_workspace_artifact_backfill")
      const threadId = Ids.ThreadId.make("migration_thread_artifact_backfill")
      const artifactId = Ids.ArtifactId.make("migration_artifact_workspace_backfill")

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* Migration.migrate().pipe(Effect.provide(Migration.layerFromFolder(priorMigrations)))
          yield* Database.withDatabase((database) => {
            database.run(sql`
              insert into thread_projections (thread_id, workspace_id, last_sequence, created_at, updated_at)
              values (${threadId}, ${workspaceId}, 1, ${historicalCreatedAt}, ${historicalCreatedAt})
            `)
            database.run(sql`
              insert into artifacts (id, thread_id, workspace_id, kind, title, content, created_at)
              values (${artifactId}, ${threadId}, null, 'other', 'Legacy trust', '{"legacy":true}', ${historicalCreatedAt})
            `)
          })
          const before = yield* ArtifactStore.listAll({ workspace_id: workspaceId, kind: "other" })
          yield* Migration.migrate().pipe(Effect.provide(Migration.layerFromFolder(Migration.sourceMigrationsFolder)))
          const after = yield* ArtifactStore.listAll({ workspace_id: workspaceId, kind: "other" })
          return { before, after }
        }).pipe(Effect.provide(testLayer)),
      )

      expect(result.before).toEqual([])
      expect(result.after).toHaveLength(1)
      expect(result.after[0]).toMatchObject({
        id: artifactId,
        thread_id: threadId,
        workspace_id: workspaceId,
        kind: "other",
        title: "Legacy trust",
      })
    } finally {
      await rm(priorMigrations, { recursive: true, force: true })
    }
  })

  test("resolves source, configured, and installed migration folders", () => {
    expect(Migration.migrationsFolderFromEnv({ RIKA_MIGRATIONS_DIR: "/tmp/rika-migrations" })).toBe(
      "/tmp/rika-migrations",
    )
    expect(Migration.migrationsFolderFromEnv({})).toBe(Migration.sourceMigrationsFolder)
    expect(Migration.installedMigrationsFolder("/opt/rika/bin/rika")).toBe("/opt/rika/share/rika/drizzle")
  })
})

const migrationsFolderWithout = async (...excluded: ReadonlyArray<string>) => {
  const target = await mkdtemp(join(tmpdir(), "rika-migrations-"))
  const excludedNames = new Set(excluded)
  const names = await readdir(Migration.sourceMigrationsFolder)
  await Promise.all(
    names
      .filter((name) => !excludedNames.has(name))
      .map((name) => cp(join(Migration.sourceMigrationsFolder, name), join(target, name), { recursive: true })),
  )
  return target
}

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
