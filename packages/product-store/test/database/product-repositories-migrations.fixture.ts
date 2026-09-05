import { Effect } from "effect"
import { Pool } from "pg"
import { identityMigrations } from "../../../identity/src/database/migrations"
import { runMigration } from "../../../identity/src/database/postgres"
import { migrations } from "../../src/hosted/migrations"
import { readFileString } from "../hosted/assignments.support"

export const applyMigrations = (url: string) =>
  Effect.gen(function* () {
    const pool = yield* Effect.sync(() => new Pool({ connectionString: url }))
    for (const migration of [...identityMigrations, ...migrations]) {
      const sql = yield* readFileString(migration.url)
      yield* runMigration({ pool, id: migration.id, checksum: migration.checksum, sql })
    }
    return pool
  })
