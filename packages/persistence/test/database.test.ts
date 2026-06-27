import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../src/index"

const selectOne = Database.withDatabase((database) => database.get<{ value: number }>(sql`select 1 as value`))

describe("Database", () => {
  test("runs queries through the in-memory layer", async () => {
    const result = await Effect.runPromise(selectOne.pipe(Effect.provide(Database.memoryLayer)))

    expect(result).toEqual({ value: 1 })
  })

  test("swaps the same service to a file-backed SQLite layer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "rika-db-"))

    try {
      const result = await Effect.runPromise(
        selectOne.pipe(Effect.provide(Database.layerFromPath(join(directory, "rika.sqlite")))),
      )

      expect(result).toEqual({ value: 1 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("enables required SQLite pragmas centrally", async () => {
    const result = await Effect.runPromise(
      Database.withDatabase((database) => database.get<{ foreign_keys: number }>(sql`pragma foreign_keys`)).pipe(
        Effect.provide(Database.memoryLayer),
      ),
    )

    expect(result).toEqual({ foreign_keys: 1 })
  })
})
