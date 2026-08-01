import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration008 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN review_fan_out_id TEXT`
})
