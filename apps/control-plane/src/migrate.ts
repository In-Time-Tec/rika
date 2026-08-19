import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { BunFileSystem } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer } from "effect"
import {
  closePostgresPool,
  identityMigrations,
  loadIdentityDatabaseConfig,
  makePostgresPool,
  runMigration,
} from "@rika/identity"

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* loadIdentityDatabaseConfig(Bun.env)
    const fileSystem = yield* FileSystem.FileSystem
    const pool = makePostgresPool(config)
    yield* Effect.addFinalizer(() => closePostgresPool(pool).pipe(Effect.ignore))
    yield* Effect.forEach(identityMigrations, (migration) =>
      Effect.gen(function* () {
        const sql = yield* fileSystem.readFileString(migration.url.pathname)
        const applied = yield* runMigration({ pool, id: migration.id, sql })
        yield* Console.log(applied ? `Applied ${migration.id}` : `${migration.id} is already applied`)
      }),
    )
  }),
)

BunRuntime.runMain(
  Effect.scopedWith((scope) =>
    Layer.buildWithScope(BunFileSystem.layer, scope).pipe(
      Effect.flatMap((context) => program.pipe(Effect.provideContext(context))),
    ),
  ),
)
