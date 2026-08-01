import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration024 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`DROP TABLE IF EXISTS rika_usage_repairs`
})

