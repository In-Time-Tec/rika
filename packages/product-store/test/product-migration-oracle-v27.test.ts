import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import * as Database from "@rika/product-store/product-database-layer"
import oracle from "./fixtures/product-migration-oracle-v27.fixture.json"

const preflightFixturePaths = {
  "initialized-empty-sqlite": new URL(
    "./fixtures/product-migration-oracle-v27/initialized-empty-sqlite.db",
    import.meta.url,
  ).pathname,
  "partial-rika-workspaces": new URL(
    "./fixtures/product-migration-oracle-v27/partial-rika-workspaces.db",
    import.meta.url,
  ).pathname,
  "future-schema-and-product-state": new URL(
    "./fixtures/product-migration-oracle-v27/future-schema-and-product-state.db",
    import.meta.url,
  ).pathname,
  "arbitrary-old-sessions-schema": new URL(
    "./fixtures/product-migration-oracle-v27/arbitrary-old-sessions-schema.db",
    import.meta.url,
  ).pathname,
} as const

const preflightFixtureSha256 = {
  "initialized-empty-sqlite": "c9eb9d107f261a8ef684b67e66d801ddae0aa2d1503cfd64e430f52ad70de412",
  "partial-rika-workspaces": "1f6ab994dcd85a21f3df4fafbb9f909b736646ec77a910f6efaaaa1d27437d3e",
  "future-schema-and-product-state": "13025c6f400b2c94c29c7b730fb415501e5107cb0ccfd297f58a67e4edae1f65",
  "arbitrary-old-sessions-schema": "debfe169353212fed80ebd2744e428dcdcfcc6619097745554f73ce14e75ece5",
} as const

type PreflightFixture = keyof typeof preflightFixturePaths
type PreflightRecipe =
  | { readonly kind: "missing-file"; readonly sidecars: Record<string, never> }
  | {
      readonly kind: "bytes"
      readonly fileBytesHex: string
      readonly sidecars: Record<string, { text: string; sha256?: string }>
    }
  | {
      readonly kind: "fixture"
      readonly fixture: PreflightFixture
      readonly sidecars: Record<string, { text: string; sha256?: string }>
    }
type PreflightCase = {
  readonly name: string
  readonly outcome: "accepted" | "rejected-unchanged"
  readonly recipe: PreflightRecipe
  readonly expected: {
    readonly migrationRows?: number
    readonly tables?: readonly string[]
    readonly fileSha256: string
    readonly sidecarSha256?: string
  }
}
const preflightCases = oracle.preflightCases as readonly PreflightCase[]

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const buildDatabase = (filename: string) => Effect.scoped(Layer.build(Database.layer(filename)))

const readObjects = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Database.layer(filename))
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient
        const objects = yield* sql`SELECT type, name, tbl_name, sql
          FROM sqlite_schema
          WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
          ORDER BY type ASC, name ASC`
        const migrations = yield* sql`SELECT migration_id, name FROM rika_migrations ORDER BY migration_id ASC`
        return { context, objects, migrations }
      }).pipe(Effect.provide(context))
    }),
  )

const writeRecipe = (filename: string, recipe: PreflightCase["recipe"], fixturePathsRead: Set<string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    if (recipe.kind === "missing-file") return
    if (recipe.kind === "bytes") {
      yield* fileSystem.writeFile(filename, Uint8Array.fromHex(recipe.fileBytesHex))
    } else {
      const fixturePath = preflightFixturePaths[recipe.fixture]
      const fixtureBytes = yield* fileSystem.readFile(fixturePath)
      fixturePathsRead.add(fixturePath)
      expect(sha256(fixtureBytes), `fixture ${recipe.fixture}`).toBe(preflightFixtureSha256[recipe.fixture])
      yield* fileSystem.writeFile(filename, fixtureBytes)
    }
    for (const [suffix, sidecar] of Object.entries(recipe.sidecars)) {
      if (sidecar !== undefined && sidecar !== null)
        yield* fileSystem.writeFileString(`${filename}-${suffix}`, sidecar.text)
    }
  })

it.layer(BunServices.layer)("v27 migration and preflight oracle", (test) => {
  test.effect("contains canonical migration metadata and matches the current projection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(oracle.migrationCount).toBe(27)
        expect(oracle.prefixes).toHaveLength(27)
        for (const prefix of oracle.prefixes) {
          const migrationTable = prefix.schema.find((entry) => entry.name === "rika_migrations")
          expect(migrationTable).toEqual({
            type: "table",
            name: "rika_migrations",
            tbl_name: "rika_migrations",
            sql: 'CREATE TABLE "rika_migrations" (\n  migration_id integer PRIMARY KEY NOT NULL,\n  created_at datetime NOT NULL DEFAULT current_timestamp,\n  name VARCHAR(255) NOT NULL\n)',
          })
          expect(prefix.tables.find((table) => table.table === "rika_migrations")).toEqual({
            table: "rika_migrations",
            columns: [
              { cid: 0, name: "migration_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
              { cid: 1, name: "created_at", type: "datetime", notnull: 1, dflt_value: "current_timestamp", pk: 0 },
              { cid: 2, name: "name", type: "VARCHAR(255)", notnull: 1, dflt_value: null, pk: 0 },
            ],
          })
          expect(prefix.constraints.find((constraint) => constraint.table === "rika_migrations")).toEqual({
            table: "rika_migrations",
            foreignKeys: [],
          })
        }

        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v27-oracle-" })
        const filename = `${directory}/rika.db`
        const current = yield* readObjects(filename)
        const expected = oracle.prefixes.at(-1)!
        expect(current.migrations.slice(0, 27)).toEqual(expected.migrationRows)
        expect(current.objects).toEqual(expected.schema)
      }),
    ),
  )

  test.effect("consumes every accepted and rejected preflight recipe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-v27-preflight-" })
        const fixturePathsRead = new Set<string>()
        for (const recipeCase of preflightCases) {
          const filename = `${directory}/${recipeCase.name}/rika.db`
          if (recipeCase.recipe.kind !== "missing-file")
            yield* fileSystem.makeDirectory(`${directory}/${recipeCase.name}`, { recursive: true })
          yield* writeRecipe(filename, recipeCase.recipe, fixturePathsRead)
          const before = yield* fileSystem.readFile(filename).pipe(Effect.orElseSucceed(() => new Uint8Array()))
          const sidecarsBefore = yield* Effect.all(
            (["wal", "shm"] as const).map((suffix) =>
              fileSystem.readFile(`${filename}-${suffix}`).pipe(Effect.orElseSucceed(() => new Uint8Array())),
            ),
          )
          const result = yield* Effect.result(buildDatabase(filename))
          if (recipeCase.outcome === "accepted") {
            expect(result._tag).toBe("Success")
            const state = yield* readObjects(filename)
            expect(state.migrations).toHaveLength(recipeCase.expected.migrationRows! + 1)
            for (const table of recipeCase.expected.tables!)
              expect(state.objects).toContainEqual(expect.objectContaining({ name: table }))
          } else {
            expect(result._tag).toBe("Failure")
            const after = yield* fileSystem.readFile(filename)
            const sidecarsAfter = yield* Effect.all(
              (["wal", "shm"] as const).map((suffix) =>
                fileSystem.readFile(`${filename}-${suffix}`).pipe(Effect.orElseSucceed(() => new Uint8Array())),
              ),
            )
            expect(Array.from(after)).toEqual(Array.from(before))
            expect(
              sidecarsAfter.map((bytes) => Array.from(bytes)),
              recipeCase.name,
            ).toEqual(sidecarsBefore.map((bytes) => Array.from(bytes)))
            if (recipeCase.expected.fileSha256 !== "generated")
              expect(sha256(before)).toBe(recipeCase.expected.fileSha256)
            if (recipeCase.expected.sidecarSha256 !== undefined) {
              const sidecar = sidecarsBefore.find((bytes) => bytes.length > 0)
              expect(sidecar).toBeDefined()
              expect(sha256(sidecar!)).toBe(recipeCase.expected.sidecarSha256)
            }
          }
        }
        expect([...fixturePathsRead].toSorted()).toEqual(
          [
            ...new Set(
              preflightCases.flatMap((recipeCase) => {
                if (recipeCase.recipe.kind !== "fixture") return []
                return [preflightFixturePaths[recipeCase.recipe.fixture]]
              }),
            ),
          ].toSorted(),
        )
      }),
    ),
  )

  test("labels every rewrite and no-rewrite operation", () => {
    const expectedRewrites = new Set([3, 6, 12, 13, 17, 20, 21, 23, 25, 26, 27])
    for (const prefix of oracle.prefixes) {
      expect(prefix.representativeRewriteRows.length).toBeGreaterThan(0)
      expect(prefix.representativeRewriteRows[0]).toHaveProperty("operation")
      if (!expectedRewrites.has(prefix.prefix))
        expect(prefix.representativeRewriteRows[0]).toHaveProperty("outcome", "no row rewrite")
    }
  })
})
