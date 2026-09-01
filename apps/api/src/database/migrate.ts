import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { BunFileSystem } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Redacted } from "effect"
import {
  closePostgresPool,
  identityMigrations,
  loadIdentityDatabaseConfig,
  makePostgresPool,
  runMigration,
} from "@rika/identity"
import { migrations as productMigrations } from "@rika/product-store/migrations"
import * as ExecutionPostgres from "@rika/execution/postgres"

interface DatabaseMigration {
  readonly id: string
  readonly aliases?: ReadonlyArray<string>
  readonly checksum: string
  readonly url: URL
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* loadIdentityDatabaseConfig(Bun.env)
    const fileSystem = yield* FileSystem.FileSystem
    const pool = makePostgresPool(config)
    yield* Effect.addFinalizer(() => closePostgresPool(pool).pipe(Effect.ignore))
    const applyMigration = (migration: DatabaseMigration) =>
      Effect.gen(function* () {
        const sql = yield* fileSystem.readFileString(migration.url.pathname)
        const input = { pool, id: migration.id, checksum: migration.checksum, sql }
        const applied = yield* runMigration(
          migration.aliases === undefined ? input : { ...input, aliases: migration.aliases },
        )
        yield* Console.log(applied ? `Applied ${migration.id}` : `${migration.id} is already applied`)
      })
    yield* Effect.forEach(identityMigrations, applyMigration)
    yield* Effect.forEach(productMigrations, applyMigration)
    yield* ExecutionPostgres.applySchema({
      url: Redacted.value(config.databaseUrl),
      source: "rika-api",
    })
    yield* Console.log("Generalist PostgreSQL schema is compatible")
  }),
)

BunRuntime.runMain(
  Effect.scopedWith((scope) =>
    Layer.buildWithScope(BunFileSystem.layer, scope).pipe(
      Effect.flatMap((context) => program.pipe(Effect.provideContext(context))),
    ),
  ),
)
