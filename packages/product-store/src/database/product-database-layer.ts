import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { additions, create, schemaFingerprint } from "./product-schema"
import { currentObjects, inspectDatabase, validateKnown } from "./product-database-inspection"

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

const prepare = Effect.gen(function* () {
  const state = yield* inspectDatabase()
  const kind = yield* validateKnown(state)
  if (kind === "fresh") {
    const sql = yield* SqlClient
    yield* sql
      .withTransaction(create)
      .pipe(Effect.mapError((error) => fail(`Could not create the Rika product database: ${String(error)}`)))
  }
  if (kind === "upgradable") {
    const sql = yield* SqlClient
    const present = new Set(state.objects.map((object) => `${object.type}:${object.name}`))
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const addition of additions) if (!present.has(addition.name)) yield* addition.apply(sql)
          yield* sql`DELETE FROM rika_schema_identity`
          yield* sql`INSERT INTO rika_schema_identity (id, fingerprint) VALUES (1, ${schemaFingerprint(
            yield* currentObjects(),
          )})`
        }),
      )
      .pipe(Effect.mapError((error) => fail(`Could not upgrade the Rika product database: ${String(error)}`)))
  }
  yield* enableForeignKeys
  yield* inspectDatabase().pipe(Effect.flatMap(validateKnown))
})

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

export const layer = (filename: string) => currentLayer(filename).pipe(Layer.provideMerge(directoryLayer(filename)))
