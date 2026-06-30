import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database, Migration } from "../src/index"

const layer = Layer.mergeAll(Database.memoryLayer, Migration.layer)

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

  test("resolves source, configured, and installed migration folders", () => {
    expect(Migration.migrationsFolderFromEnv({ RIKA_MIGRATIONS_DIR: "/tmp/rika-migrations" })).toBe(
      "/tmp/rika-migrations",
    )
    expect(Migration.migrationsFolderFromEnv({})).toBe(Migration.sourceMigrationsFolder)
    expect(Migration.installedMigrationsFolder("/opt/rika/bin/rika")).toBe("/opt/rika/share/rika/drizzle")
  })
})
