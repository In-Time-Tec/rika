import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { schemaFingerprint, schemaObjects as productSchemaObjects } from "./product-schema"
import { ProductDatabaseError } from "./product-database-layer"

const SchemaObject = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  table_name: Schema.String,
  sql: Schema.NullOr(Schema.String),
})
const SchemaIdentity = Schema.Struct({ fingerprint: Schema.String })
const incompatible = "Rika product database does not match the current schema. Use a fresh Rika data root."
const fail = (message: string) => ProductDatabaseError.make({ message })

export const inspectDatabase = Effect.fn("ProductDatabase.inspect")(function* () {
  const sql = yield* SqlClient
  const objects = yield* sql`SELECT type, name, tbl_name AS table_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY type ASC, name ASC`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SchemaObject))),
    Effect.mapError((error) => fail(`Could not inspect the Rika product database: ${String(error)}`)),
  )
  const identity = objects.some(({ name }) => name === "rika_schema_identity")
    ? yield* sql`SELECT fingerprint FROM rika_schema_identity WHERE id = 1`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SchemaIdentity))),
        Effect.mapError((error) => fail(`Could not inspect Rika product database identity: ${String(error)}`)),
      )
    : []
  return { objects, fingerprint: identity[0]?.fingerprint }
})

export const validateKnown = (state: Effect.Success<ReturnType<typeof inspectDatabase>>) =>
  Effect.gen(function* () {
    if (state.objects.length === 0) return "fresh" as const
    const actual = new Set(state.objects.map((object) => `${object.type}:${object.name}`))
    if (
      actual.size !== productSchemaObjects.length ||
      productSchemaObjects.some((key) => !actual.has(key)) ||
      state.fingerprint !== schemaFingerprint(state.objects)
    )
      return yield* fail(incompatible)
    return "current" as const
  })
