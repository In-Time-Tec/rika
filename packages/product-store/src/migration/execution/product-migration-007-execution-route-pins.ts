import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration007 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN execution_route_json TEXT`
})

