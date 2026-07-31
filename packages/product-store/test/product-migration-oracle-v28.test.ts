import * as BunServices from "@effect/platform-bun/BunServices"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Database as NativeDatabase } from "bun:sqlite"
import * as Database from "@rika/product-store/product-database-layer"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import oracle from "./fixtures/product-migration-oracle-v28.fixture.json"

const makeDatabase = (filename: string) => Effect.scoped(Layer.build(Database.layer(filename)))

const prepareV27 = (filename: string, routeText: string) =>
  Effect.sync(() => {
    const database = new NativeDatabase(filename)
    database.exec("DELETE FROM rika_migrations WHERE migration_id = 28")
    database.exec("INSERT INTO rika_workspaces (path, created_at) VALUES ('/oracle', 1)")
    database.exec(
      "INSERT INTO rika_threads (id, workspace, title, labels_json, pinned, archived, created_at, updated_at) VALUES ('oracle-thread', '/oracle', 'Oracle', '[]', 0, 0, 1, 1)",
    )
    database
      .query(
        "INSERT INTO rika_turns (id, thread_id, prompt, status, execution_route_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("oracle-turn", "oracle-thread", "oracle", "completed", routeText, 1, 1)
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    database.close()
  })

const readRoute = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Database.layer(filename))
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient
        const rows = yield* sql<{ readonly execution_route_json: string }>`
          SELECT execution_route_json FROM rika_turns WHERE id = 'oracle-turn'
        `
        return yield* Schema.decodeUnknownEffect(ExecutionRouteSnapshot)(
          yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(rows[0]!.execution_route_json),
        )
      }).pipe(Effect.provide(context))
    }),
  )

const databaseSidecars = (filename: string) => [filename, `${filename}-wal`, `${filename}-shm`]

it.layer(BunServices.layer)("v28 migration oracle", (test) => {
  test.effect("rewrites the authoritative fixture and preserves every canonical field", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(oracle.migrationCount).toBe(28)
        expect(oracle.migrationName).toBe("product_route_snapshot")
        expect(oracle.legacyRoute).toBeDefined()
        expect(oracle.expectedSnapshot).toBeDefined()
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-oracle-" })
        const filename = `${directory}/rika.db`
        yield* makeDatabase(filename)
        const routeText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(oracle.legacyRoute)
        yield* prepareV27(filename, routeText)
        yield* makeDatabase(filename)
        expect(yield* readRoute(filename)).toEqual(oracle.expectedSnapshot)
      }),
    ),
  )

  test.effect("rejects every declared future version before writing database or sidecar bytes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v28-reject-" })
        for (const version of oracle.rejectedVersions) {
          const filename = `${directory}/${version}/rika.db`
          yield* makeDatabase(filename)
          const futureRoute = { ...oracle.legacyRoute, version }
          const routeText = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.UnknownFromJsonString))(futureRoute)
          yield* prepareV27(filename, routeText)
          const before = new Map<string, Uint8Array>()
          for (const path of databaseSidecars(filename))
            if (yield* fileSystem.exists(path)) before.set(path, yield* fileSystem.readFile(path))
          const result = yield* Effect.result(makeDatabase(filename))
          expect(result._tag).toBe("Failure")
          for (const path of databaseSidecars(filename)) {
            const exists = yield* fileSystem.exists(path)
            expect(exists).toBe(before.has(path))
            if (exists) expect(yield* fileSystem.readFile(path)).toEqual(before.get(path))
          }
        }
      }),
    ),
  )
})
