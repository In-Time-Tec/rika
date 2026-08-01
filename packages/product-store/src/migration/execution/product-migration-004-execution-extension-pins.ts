import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"

export const migration004 = Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE rika_turns ADD COLUMN extension_pin_json TEXT`
})
