import { Effect, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { additions, schemaFingerprint, schemaObjects as productSchemaObjects } from "./product-schema"
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

/** The schema objects a database currently holds, for recomputing identity after an upgrade. */
export const currentObjects = Effect.fn("ProductDatabase.currentObjects")(function* () {
  const state = yield* inspectDatabase()
  return state.objects
})

export const validateKnown = (state: Effect.Success<ReturnType<typeof inspectDatabase>>) =>
  Effect.gen(function* () {
    if (state.objects.length === 0) return "fresh" as const
    const actual = new Set(state.objects.map((object) => `${object.type}:${object.name}`))
    const missing = productSchemaObjects.filter((key) => !actual.has(key))
    /**
     * A data root outlives the version that made it. A database missing only objects a later release
     * added is upgradable; anything else differs in a way this cannot reason about.
     */
    if (missing.length > 0 && missing.every((key) => additions.some((addition) => addition.name === key)))
      return "upgradable" as const
    if (
      actual.size !== productSchemaObjects.length ||
      missing.length > 0 ||
      state.fingerprint !== schemaFingerprint(state.objects)
    )
      return yield* fail(incompatible)
    return "current" as const
  })
