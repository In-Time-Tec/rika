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

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* loadIdentityDatabaseConfig(Bun.env)
    const fileSystem = yield* FileSystem.FileSystem
    const pool = makePostgresPool(config)
    yield* Effect.addFinalizer(() => closePostgresPool(pool).pipe(Effect.ignore))
    yield* Effect.forEach([...identityMigrations, ...productMigrations], (migration) =>
      Effect.gen(function* () {
        const sql = yield* fileSystem.readFileString(migration.url.pathname)
        const applied = yield* runMigration({ pool, id: migration.id, sql })
        yield* Console.log(applied ? `Applied ${migration.id}` : `${migration.id} is already applied`)
      }),
    )
    yield* ExecutionPostgres.applySchema({
      url: Redacted.value(config.databaseUrl),
      source: "rika-control-plane",
    })
  }),
)

BunRuntime.runMain(
  Effect.scopedWith((scope) =>
    Layer.buildWithScope(BunFileSystem.layer, scope).pipe(
      Effect.flatMap((context) => program.pipe(Effect.provideContext(context))),
    ),
  ),
)
