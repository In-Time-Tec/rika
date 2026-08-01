import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect"
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { migrationNames } from "../migration/product-migration-registry"
import { schemaObjectsByMigration } from "./product-database-schema-manifest"
import { ProductDatabaseError } from "./product-database-layer"

const SchemaObject = Schema.Struct({ type: Schema.String, name: Schema.String })
const MigrationRow = Schema.Struct({ migration_id: Schema.Finite, name: Schema.String })
const incompatible = "Rika product database does not match the current schema. Use a fresh Rika data root."
const fail = (message: string) => ProductDatabaseError.make({ message })

export const inspectDatabase = Effect.fn("ProductDatabase.inspect")(function* () {
  const sql = yield* SqlClient
  const objects = yield* sql`SELECT type, name
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SchemaObject))),
    Effect.mapError((error) => fail(`Could not inspect the Rika product database: ${String(error)}`)),
  )
  const hasMigrationTable = objects.some((object) => object.type === "table" && object.name === "rika_migrations")
  const migrationRows = hasMigrationTable
    ? yield* sql`SELECT migration_id, name FROM rika_migrations ORDER BY migration_id ASC`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MigrationRow))),
        Effect.mapError((error) => fail(`Could not inspect Rika product database migrations: ${String(error)}`)),
      )
    : []
  return { objects, migrationRows }
})

export const validateKnown = (state: Effect.Success<ReturnType<typeof inspectDatabase>>) =>
  Effect.gen(function* () {
    if (state.objects.length === 0) return "fresh" as const
    for (const [index, row] of state.migrationRows.entries())
      if (row.migration_id !== index + 1 || row.name !== migrationNames[index]) return yield* fail(incompatible)
    const expected = schemaObjectsByMigration[state.migrationRows.length]
    if (expected === undefined) return yield* fail(incompatible)
    const actual = new Set(state.objects.map((object) => `${object.type}:${object.name}`))
    if (actual.size !== expected.length || expected.some((key) => !actual.has(key))) return yield* fail(incompatible)
    return "tracked" as const
  })

export const inspectExisting = (filename: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const inspectionDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-database-inspect-" })
    const inspectionFilename = `${inspectionDirectory}/rika.db`
    for (const suffix of ["", "-wal"] as const) {
      const source = `${filename}${suffix}`
      if (yield* fileSystem.exists(source))
        yield* fileSystem.writeFile(`${inspectionFilename}${suffix}`, yield* fileSystem.readFile(source))
    }
    const inspect = (candidate: string) =>
      Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(SqliteClient.layer({ filename: candidate }))
            return yield* inspectDatabase().pipe(Effect.provide(context))
          }),
        ),
      )
    const initial = yield* inspect(inspectionFilename)
    const outcome = yield* Exit.match(initial, {
      onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
      onFailure: () =>
        Effect.gen(function* () {
          if (yield* fileSystem.exists(`${inspectionFilename}-wal`)) return initial
          const path = yield* Path.Path
          const fileUrl = yield* path.toFileUrl(inspectionFilename).pipe(
            Effect.mapError((error) => fail(`Could not resolve the Rika product database path: ${String(error)}`)),
          )
          fileUrl.searchParams.set("immutable", "1")
          return yield* inspect(fileUrl.href)
        }),
    })
    if (Exit.isFailure(outcome))
      return yield* fail(
        `Could not open the Rika product database without changing it: ${Cause.pretty(outcome.cause)}. Use a fresh Rika data root.`,
      )
    return outcome.value
  })

export const sqliteHeader = new TextEncoder().encode("SQLite format 3\u0000")

export const readPrefix = Effect.fn("ProductDatabase.readPrefix")(function* (filename: string, length: number) {
  const fileSystem = yield* FileSystem.FileSystem
  return yield* Effect.scoped(
    fileSystem.open(filename, { flag: "r" }).pipe(
      Effect.flatMap((file) => file.readAlloc(length)),
      Effect.map(Option.getOrElse(() => new Uint8Array())),
    ),
  )
})
