import { Database as BunSqliteDatabase } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Config } from "@rika/core"
import { Context, Effect, Layer, Schema } from "effect"
import { drizzle } from "drizzle-orm/bun-sqlite"
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { schema } from "./schema"

export type DrizzleDatabase = SQLiteBunDatabase<typeof schema>

export class DatabaseError extends Schema.TaggedErrorClass<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  operation: Schema.String,
}) {}

export interface Interface {
  readonly withDatabase: <A>(operation: (database: DrizzleDatabase) => A) => Effect.Effect<A, DatabaseError>
  readonly withDatabaseEffect: <A, E, R>(
    operation: (database: DrizzleDatabase) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | DatabaseError, R>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/Database") {}

export const pathFromConfig = (config: Config.Values) => config.database_url ?? `${config.data_dir}/rika.sqlite`

export const layerFromPath = (path: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const sqlite = yield* openSqlite(path)
      const database = drizzle({ client: sqlite, schema })
      return makeService(database)
    }),
  )

export const memoryLayer = layerFromPath(":memory:")

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    return layerFromPath(pathFromConfig(values))
  }),
)

export const withDatabase = Effect.fn("Database.withDatabase.call")(function* <A>(
  operation: (database: DrizzleDatabase) => A,
) {
  const database = yield* Service
  return yield* database.withDatabase(operation)
})

export const withDatabaseEffect = Effect.fn("Database.withDatabaseEffect.call")(function* <A, E, R>(
  operation: (database: DrizzleDatabase) => Effect.Effect<A, E, R>,
) {
  const database = yield* Service
  return yield* database.withDatabaseEffect(operation)
})

const makeService = (database: DrizzleDatabase) =>
  Service.of({
    withDatabase: Effect.fn("Database.withDatabase")(function* <A>(operation: (database: DrizzleDatabase) => A) {
      const result = yield* Effect.try({
        try: () => operation(database),
        catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "withDatabase" }),
      })
      return result
    }),
    withDatabaseEffect: Effect.fn("Database.withDatabaseEffect")(function* <A, E, R>(
      operation: (database: DrizzleDatabase) => Effect.Effect<A, E, R>,
    ) {
      const effect = yield* Effect.try({
        try: () => operation(database),
        catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "withDatabaseEffect" }),
      })
      return yield* effect
    }),
  })

const openSqlite = (path: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: () => {
        ensureParentDirectory(path)
        const sqlite = new BunSqliteDatabase(path, { create: true })
        configureSqlite(sqlite, path)
        return sqlite
      },
      catch: (cause) => new DatabaseError({ message: describeCause(cause), operation: "open" }),
    }),
    (sqlite) => Effect.sync(() => sqlite.close()).pipe(Effect.ignore),
  )

const ensureParentDirectory = (path: string) => {
  if (path === ":memory:" || path.startsWith("file:")) return
  mkdirSync(dirname(path), { recursive: true })
}

const configureSqlite = (sqlite: BunSqliteDatabase, path: string) => {
  sqlite.exec("PRAGMA foreign_keys = ON")
  sqlite.exec("PRAGMA busy_timeout = 5000")
  if (path !== ":memory:") sqlite.exec("PRAGMA journal_mode = WAL")
  sqlite.exec("PRAGMA synchronous = NORMAL")
}

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
