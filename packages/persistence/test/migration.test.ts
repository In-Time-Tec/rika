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
})
