import { fileURLToPath } from "node:url"
import { Context, Effect, Layer, Schema } from "effect"
import { migrate as migrateDatabase } from "drizzle-orm/bun-sqlite/migrator"
import { DatabaseError, Service as DatabaseService, withDatabaseEffect } from "./database"

export const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url))

export class MigrationError extends Schema.TaggedErrorClass<MigrationError>()("MigrationError", {
  message: Schema.String,
  migrations_folder: Schema.String,
}) {}

export interface Interface {
  readonly migrate: () => Effect.Effect<void, DatabaseError | MigrationError, DatabaseService>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/Migration") {}

export const layerFromFolder = (migrationsFolder = defaultMigrationsFolder) =>
  Layer.succeed(
    Service,
    Service.of({
      migrate: Effect.fn("Migration.migrate")(function* () {
        return yield* withDatabaseEffect((database) =>
          Effect.try({
            try: () => migrateDatabase(database, { migrationsFolder }),
            catch: (cause) =>
              new MigrationError({ message: describeCause(cause), migrations_folder: migrationsFolder }),
          }).pipe(Effect.asVoid),
        )
      }),
    }),
  )

export const layer = layerFromFolder()

export const migrate = Effect.fn("Migration.migrate.call")(function* () {
  const migration = yield* Service
  return yield* migration.migrate()
})

const describeCause = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
