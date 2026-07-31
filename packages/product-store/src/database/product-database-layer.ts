import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { productMigrations, migrationNames } from "../migration/product-migration-registry"
import { inspectDatabase, validateKnown } from "./product-database-inspection"
import { preflight } from "./product-database-preflight"

export class ProductDatabaseError extends Schema.TaggedErrorClass<ProductDatabaseError>()("ProductDatabaseError", {
  message: Schema.String,
}) {}

const fail = (message: string) => ProductDatabaseError.make({ message })

const enableForeignKeys = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`PRAGMA foreign_keys = ON`.pipe(
    Effect.mapError((error) => fail(`Could not enable Rika product database constraints: ${String(error)}`)),
  )
})

const validateCurrent = Effect.gen(function* () {
  const state = yield* inspectDatabase()
  yield* validateKnown(state)
  if (state.migrationRows.length !== migrationNames.length) return yield* fail("Rika product database does not match the current schema. Use a fresh Rika data root.")
})

const prepare = SqliteMigrator.run({ loader: productMigrations, table: "rika_migrations" }).pipe(
  Effect.mapError((error) => fail(`Could not migrate the Rika product database: ${String(error)}`)),
  Effect.andThen(enableForeignKeys),
  Effect.andThen(validateCurrent),
)

const directoryLayer = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fileSystem.makeDirectory(path.dirname(filename), { recursive: true })
    }),
  )

const currentLayer = (filename: string) =>
  Layer.effectDiscard(prepare).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))

export const layer = (filename: string) =>
  Layer.unwrap(preflight(filename).pipe(Effect.as(currentLayer(filename)))).pipe(
    Layer.provideMerge(directoryLayer(filename)),
  )
